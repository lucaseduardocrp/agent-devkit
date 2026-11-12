import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eConfigForm } from '../src/features/e2e/E2eConfigForm.js';
import type { ApiClient } from '../src/lib/api-client.js';
import type { E2eCreationDetail } from '../src/features/e2e/e2e-types.js';
// jsdom lacks Blob.text(), which every supported browser provides.
beforeAll(() => {
  Blob.prototype.text ??= function (this: Blob) {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(this);
    });
  };
});

const agents = [
  { id: 'doc', name: 'Docs', role: 'DOCUMENTATION' },
  { id: 'qa', name: 'QA Engineer', role: 'QA' },
];

const repositories = [
  { id: '42', provider: 'github', name: 'acme/demo-app', defaultBranch: 'main' },
  { id: 'guid-1', provider: 'azure_devops', name: 'Finance/app', defaultBranch: 'develop' },
];

function existing(overrides: Partial<E2eCreationDetail> = {}): E2eCreationDetail {
  return {
    id: 'c1',
    agentId: 'doc',
    name: 'ama',
    mode: 'frontend',
    scope: 'codebase',
    baseUrl: 'https://sample.trycloudflare.com',
    path: '/e/123',
    username: 'qa@example.com',
    hasPassword: true,
    reporting: null,
    lastReport: null,
    prdFileNames: ['prd.md'],
    repository: {
      provider: 'github',
      id: '42',
      name: 'acme/demo-app',
      branch: 'feature/e2e',
      path: 'tests/e2e/ama',
    },
    status: 'completed',
    error: null,
    createdAt: '2026-01-30T09:23:00Z',
    updatedAt: '2026-01-30T09:36:00Z',
    finishedAt: '2026-01-30T09:36:00Z',
    tests: [],
    prd: '# prd.md\n\nQuestions',
    diff: null,
    instructions: null,
    ...overrides,
  };
}

const SAVED_SUITES = [
  { id: 'root', name: 'Sprint 10', workspaceId: 'ws', createdAt: '', updatedAt: '' },
  { id: 'login', name: 'Login', parentId: 'root', workspaceId: 'ws', createdAt: '', updatedAt: '' },
  { id: 'other', name: 'Other', workspaceId: 'ws', createdAt: '', updatedAt: '' },
];
const savedCase = (caseId: string, title: string) => ({
  title,
  description: '',
  steps: [],
  metadata: { caseId },
});
const SAVED_PLANS = [
  {
    id: 'plan-login',
    workspaceId: 'ws',
    title: 'Login',
    suiteId: 'login',
    sourceType: 'test_management',
    plans: [
      savedCase('c1', 'Valid login'),
      savedCase('c2', 'Wrong password'),
      { title: 'Legacy', description: '', steps: [] },
    ],
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'plan-root',
    workspaceId: 'ws',
    title: 'Smoke',
    suiteId: 'root',
    plans: [savedCase('c3', 'Home loads')],
    createdAt: '',
    updatedAt: '',
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  options: {
    agents?: unknown[] | Error;
    create?: ReturnType<typeof vi.fn>;
    onOpenAgents?: () => void;
    repositories?: { repositories: unknown[]; warnings: unknown[] } | Error;
    branches?: unknown[] | Error;
    onOpenIntegrations?: () => void;
    creationId?: string;
    getCreation?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    runners?: unknown[];
    initialSavedCases?: { suiteId?: string; planId?: string; caseIds?: string[] };
    savedPlans?: unknown[] | Error | Promise<unknown[]>;
    /** A local install: the ADK workers open http://localhost on the user's computer. */
    workersReachLocalhost?: boolean;
    /** Where the server runs new E2E runs unless the form says otherwise. */
    defaultExecutionTarget?: 'remote' | 'local';
  } = {},
) {
  const client = {
    apiUrl: 'https://api.adk.example.com',
    getCapabilities: vi.fn().mockResolvedValue({
      workersReachLocalhost: options.workersReachLocalhost ?? false,
      defaultExecutionTarget: options.defaultExecutionTarget ?? 'remote',
    }),
    getE2eRunners: vi.fn().mockResolvedValue(options.runners ?? []),
    getAgents: vi.fn(() =>
      options.agents instanceof Error
        ? Promise.reject(options.agents)
        : Promise.resolve(options.agents ?? agents),
    ),
    getE2eRepositories: vi.fn(() =>
      options.repositories instanceof Error
        ? Promise.reject(options.repositories)
        : Promise.resolve(options.repositories ?? { repositories, warnings: [] }),
    ),
    getE2eBranches: vi.fn((_provider: string, id: string) =>
      options.branches instanceof Error
        ? Promise.reject(options.branches)
        : Promise.resolve(
            options.branches ??
              (id === '42'
                ? [
                    { name: 'main', isDefault: true },
                    { name: 'feature/e2e', isDefault: false },
                  ]
                : [{ name: 'develop', isDefault: true }]),
          ),
    ),
    checkE2eTunnel: vi.fn().mockResolvedValue({ reachable: true, reason: 'ok', status: 200 }),
    createE2eCreation: options.create ?? vi.fn().mockResolvedValue({ id: 'c1' }),
    getE2eCreation: options.getCreation ?? vi.fn().mockResolvedValue(existing()),
    updateE2eCreation: options.update ?? vi.fn().mockResolvedValue({ id: 'c1', name: 'saved' }),
    getTestSuites: vi.fn().mockResolvedValue(SAVED_SUITES),
    getAllSavedTestPlans: vi.fn(() =>
      options.savedPlans instanceof Promise
        ? options.savedPlans
        : options.savedPlans instanceof Error
          ? Promise.reject(options.savedPlans)
          : Promise.resolve(options.savedPlans ?? SAVED_PLANS),
    ),
  };
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <E2eConfigForm
      apiClient={client as unknown as ApiClient}
      creationId={options.creationId}
      onCreated={onCreated}
      onCancel={onCancel}
      onOpenAgents={options.onOpenAgents}
      onOpenIntegrations={options.onOpenIntegrations}
      initialSavedCases={options.initialSavedCases}
    />,
  );
  return { client, view, onCreated, onCancel };
}

async function chooseRepository(
  view: ReturnType<typeof render>,
  key = 'github:42',
  branch = 'main',
) {
  await waitFor(() =>
    expect(view.getByLabelText('Repositório').querySelectorAll('option').length).toBeGreaterThan(1),
  );
  fireEvent.change(view.getByLabelText('Repositório'), { target: { value: key } });
  await waitFor(() =>
    expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe(branch),
  );
}

function file(name: string, content: string, size?: number): File {
  const value = new File([content], name, { type: 'text/plain' });
  if (size !== undefined) Object.defineProperty(value, 'size', { value: size });
  return value;
}

describe('E2eConfigForm', () => {
  it('sends a localhost address to My computer instead of offering a tunnel', async () => {
    const { view, client } = setup();
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    expect(view.queryByRole('button', { name: /Iniciar o t.nel/ })).toBeNull();
    expect(view.queryByRole('button', { name: /Autenticação do túnel/ })).toBeNull();
    expect(view.queryByText(/devkit tunnel/)).toBeNull();
    expect(view.getByRole('status')).toHaveTextContent(/Escolha “Meu computador” acima/);
    expect(view.getByText(/escolha “Meu computador”/)).toBeInTheDocument();
  });

  it('requires a public URL for the ADK servers and checks that it is reachable', async () => {
    const { view, client } = setup();
    await waitFor(() =>
      expect(view.getByLabelText('Repositório').querySelectorAll('option').length).toBeGreaterThan(
        1,
      ),
    );
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'http://localhost:5173/login' },
    });
    expect(view.queryByText(/devkit tunnel/)).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(
      view.getByText(
        'Informe uma URL HTTPS pública. Endereços localhost só podem ser acessados neste computador.',
      ),
    ).toBeInTheDocument();
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Verificar conexão' }));
    expect(await view.findByText(/Conexão confirmada/)).toBeInTheDocument();
    expect(client.checkE2eTunnel).toHaveBeenCalledWith('https://sample.trycloudflare.com', {});
  });

  it('explains when authentication to a protected tunnel fails', async () => {
    const { view, client } = setup();
    client.checkE2eTunnel.mockResolvedValue({
      reachable: false,
      reason: 'authentication',
      status: 403,
    });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://secure.example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Verificar conexão' }));
    expect(await view.findByText(/O túnel exige autenticação/)).toBeInTheDocument();
  });

  it('warns about missing localhost origin when a Quick Tunnel URL is pasted', async () => {
    const { view } = setup();
    await waitFor(() =>
      expect(
        view.getByRole('combobox', { name: /^Reposit/ }).querySelectorAll('option').length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    expect(view.getByText(/Sem ele, o login pode falhar por CORS/)).toBeInTheDocument();
    fireEvent.change(view.getByLabelText(/local original/), {
      target: { value: 'http://localhost:8014' },
    });
    expect(view.queryByText(/Sem ele, o login pode falhar por CORS/)).toBeNull();
  });

  it('explains when the local server rejects the tunnel hostname', async () => {
    const { view, client } = setup();
    client.checkE2eTunnel.mockResolvedValue({
      reachable: false,
      reason: 'host_error',
      status: 200,
    });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Verificar conexão' }));

    expect(
      await view.findByText(/aplicação rejeitou o nome do endereço do túnel/),
    ).toBeInTheDocument();
  });

  it('requires the local browser address to be an origin without a path', async () => {
    const { view } = setup();
    await waitFor(() =>
      expect(
        view.getByRole('combobox', { name: /^Reposit/ }).querySelectorAll('option').length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.change(view.getByLabelText(/local original/), {
      target: { value: 'http://localhost:8014/login' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(view.getByText(/Informe uma origem HTTP localhost/)).toBeInTheDocument();
    fireEvent.change(view.getByLabelText(/local original/), {
      target: { value: 'http://localhost:8014' },
    });
    expect(view.queryByText(/Informe uma origem HTTP localhost/)).toBeNull();
  });

  it('keeps the form visible if a tunnel check returns an unknown status', async () => {
    const { view, client } = setup();
    client.checkE2eTunnel.mockResolvedValue({ reachable: false, reason: 'unknown', status: 200 });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Verificar conexão' }));

    expect(await view.findByText(/Não foi possível verificar a URL agora/)).toBeInTheDocument();
    expect(view.getByLabelText('URL base')).toBeInTheDocument();
  });

  it('runs a localhost app on the user computer without a tunnel', async () => {
    const { client, view, onCreated } = setup();
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    expect(view.getByRole('radio', { name: 'Servidores do ADK' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(view.getByRole('radio', { name: 'Meu computador' }));
    expect(view.getByRole('radio', { name: 'Meu computador' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(view.queryByRole('button', { name: /Autenticação do túnel/ })).toBeNull();
    expect(await view.findByText('Nenhum executor online')).toBeInTheDocument();
    expect(
      view.getByText('devkit login --api-url https://api.adk.example.com'),
    ).toBeInTheDocument();
    expect(view.getByText('devkit runner')).toBeInTheDocument();
    expect(view.getByText('npm install -g @agent-devkit/cli')).toBeInTheDocument();
    expect(view.queryByText('devkit e2e setup')).toBeNull();

    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'local' } });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'http://localhost:8014' },
    });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'PRD' } });
    await chooseRepository(view);
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1' }));
    expect(client.createE2eCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://localhost:8014',
        localOrigin: '',
        executionTarget: 'local',
      }),
    );
  });

  it('moves a tunnel run to the local runner using its localhost origin', async () => {
    const { view, client } = setup({
      creationId: 'c1',
      runners: [
        {
          id: 'runner-1',
          name: 'QA-LAPTOP',
          platform: 'win32',
          version: '0.2.0',
          lastSeenAt: '2026-10-13T10:00:00Z',
          online: true,
        },
      ],
      getCreation: vi.fn().mockResolvedValue(existing({ localOrigin: 'http://localhost:8014' })),
    });
    fireEvent.click(await view.findByRole('radio', { name: 'Meu computador' }));
    expect((view.getByLabelText('URL base') as HTMLInputElement).value).toBe(
      'http://localhost:8014',
    );
    expect(await view.findByText('Executor online')).toBeInTheDocument();
    expect(view.getByText('QA-LAPTOP')).toBeInTheDocument();
    expect(view.getByText('devkit e2e run c1')).toBeInTheDocument();
    expect(view.queryByText('devkit runner')).toBeNull();
    expect(client.getE2eRunners).toHaveBeenCalled();
  });

  it('uses the Brain instead of a PRD from the knowledge tabs', async () => {
    const { client, view, onCreated } = setup();
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    // The PRD tab is the default and shows the upload inputs.
    expect(view.getByRole('tab', { name: 'Usar PRD' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByTestId('e2e-prd-input')).toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Usar Brain' }));
    expect(view.getByRole('tab', { name: 'Usar Brain' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getByTestId('e2e-brain-panel')).toBeInTheDocument();
    expect(view.queryByTestId('e2e-prd-input')).toBeNull();

    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'ama' } });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    await chooseRepository(view);
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(client.createE2eCreation).toHaveBeenCalled());
    const input = client.createE2eCreation.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ prd: '', prdFileNames: [], useBrain: true });
    expect(onCreated).toHaveBeenCalled();
  });

  it('opens an existing Brain run on the Brain tab', async () => {
    const { view } = setup({
      creationId: 'c1',
      getCreation: vi.fn().mockResolvedValue(existing({ useBrain: true, prd: '' })),
    });
    expect(await view.findByTestId('e2e-brain-panel')).toBeInTheDocument();
    expect(view.getByRole('tab', { name: 'Usar Brain' })).toHaveAttribute('aria-selected', 'true');
  });

  it('submits a frontend run with uploaded and pasted specs and credentials', async () => {
    const { client, view, onCreated } = setup();
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    expect(view.getByRole('radio', { name: 'Frontend' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: ' ama ' } });
    fireEvent.change(view.getByLabelText('Usuário da conta de teste'), {
      target: { value: 'qa@example.com' },
    });
    fireEvent.change(view.getByLabelText('Senha da conta de teste'), {
      target: { value: '123456abc' },
    });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.change(view.getByLabelText('Caminho'), { target: { value: 'e/123' } });
    fireEvent.change(view.getByTestId('e2e-prd-input'), {
      target: { files: [file('prd.md', '# Questions'), file('rules.txt', 'Vote once')] },
    });
    expect(await view.findByText('prd.md')).toBeInTheDocument();
    fireEvent.change(view.getByTestId('e2e-prd-input'), {
      target: { files: [file('prd.md', '# Questions v2')] },
    });
    // Let the FileReader finish replacing the earlier upload of the same name.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    fireEvent.click(view.getByRole('button', { name: 'Remover rules.txt' }));
    expect(view.queryByText('rules.txt')).toBeNull();
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'Extra' } });
    fireEvent.change(view.getByLabelText('Instruções extras'), {
      target: { value: ' focus on votes ' },
    });
    fireEvent.change(view.getByLabelText('Agente'), { target: { value: 'doc' } });
    // The scripts folder follows the run name until the user edits it.
    expect((view.getByLabelText('Pasta dos scripts no projeto') as HTMLInputElement).value).toBe(
      'tests/e2e/ama',
    );
    await chooseRepository(view);
    fireEvent.change(view.getByLabelText('Branch base'), { target: { value: 'feature/e2e' } });
    fireEvent.change(view.getByLabelText('Pasta dos scripts no projeto'), {
      target: { value: 'e2e/questions' },
    });
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'renamed' } });
    expect((view.getByLabelText('Pasta dos scripts no projeto') as HTMLInputElement).value).toBe(
      'e2e/questions',
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: ' ama ' } });

    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1' }));
    expect(client.createE2eCreation).toHaveBeenCalledWith({
      repository: { provider: 'github', id: '42', branch: 'feature/e2e', path: 'e2e/questions' },
      name: 'ama',
      agentId: 'doc',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'https://sample.trycloudflare.com',
      localOrigin: '',
      executionTarget: 'remote',
      path: 'e/123',
      username: 'qa@example.com',
      password: '123456abc',
      prd: '# prd.md\n\n# Questions v2\n\n---\n\nExtra',
      prdFileNames: ['prd.md'],
      instructions: 'focus on votes',
    });
  });

  it('validates required fields and clears errors as the user types', async () => {
    const { view, client } = setup();
    await waitFor(() => expect(client.getAgents).toHaveBeenCalled());
    fireEvent.change(view.getByLabelText('URL base'), { target: { value: 'localhost' } });
    fireEvent.click(view.getByRole('radio', { name: 'Code diff' }));
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    for (const message of [
      'Informe o nome da execução.',
      'Informe uma URL http(s) válida.',
      'Envie ou cole o documento do produto.',
      'Cole ou carregue o diff do código.',
      'Selecione o repositório e a branch.',
    ])
      expect(view.getByText(message)).toBeInTheDocument();
    expect(client.createE2eCreation).not.toHaveBeenCalled();
    await chooseRepository(view, 'azure_devops:guid-1', 'develop');
    expect(view.queryByText('Selecione o repositório e a branch.')).toBeNull();

    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'x' } });
    expect(view.queryByText('Informe o nome da execução.')).toBeNull();
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'p' } });
    expect(view.queryByText('Envie ou cole o documento do produto.')).toBeNull();
  });

  it('submits a backend diff run with an uploaded patch', async () => {
    const { client, view } = setup();
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    fireEvent.click(view.getByRole('radio', { name: 'Backend' }));
    fireEvent.click(view.getByRole('radio', { name: 'Code diff' }));
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(view.getByRole('button', { name: /Carregar arquivo .diff/ }));
    fireEvent.click(view.getByRole('button', { name: /Selecione seu documento/ }));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
    fireEvent.change(view.getByTestId('e2e-diff-input'), {
      target: { files: [file('change.patch', '+ endpoint')] },
    });
    await waitFor(() =>
      expect((view.getByLabelText('Diff do código') as HTMLTextAreaElement).value).toBe(
        '+ endpoint',
      ),
    );
    fireEvent.change(view.getByTestId('e2e-diff-input'), { target: { files: [] } });
    fireEvent.change(view.getByLabelText('Diff do código'), { target: { value: '+ endpoint v2' } });
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'api' } });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'API' } });
    await chooseRepository(view, 'azure_devops:guid-1', 'develop');
    fireEvent.change(view.getByLabelText('Pasta dos scripts no projeto'), {
      target: { value: ' ' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(client.createE2eCreation).toHaveBeenCalled());
    expect(client.createE2eCreation.mock.calls[0]![0]).toMatchObject({
      mode: 'backend',
      scope: 'diff',
      diff: '+ endpoint v2',
      path: '',
      prdFileNames: [],
      repository: { provider: 'azure_devops', id: 'guid-1', branch: 'develop', path: '' },
    });
    expect(client.createE2eCreation.mock.calls[0]![0]).not.toHaveProperty('username');
  });

  it('submits with the default branch while the branch list is still loading', async () => {
    const { client, view } = setup();
    client.getE2eBranches.mockReturnValue(new Promise(() => undefined));
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'api' } });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'PRD' } });
    await waitFor(() =>
      expect(view.getByLabelText('Repositório').querySelectorAll('option').length).toBe(3),
    );
    fireEvent.change(view.getByLabelText('Repositório'), {
      target: { value: 'azure_devops:guid-1' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(client.createE2eCreation).toHaveBeenCalled());
    expect(client.createE2eCreation.mock.calls[0]![0].repository).toMatchObject({
      provider: 'azure_devops',
      id: 'guid-1',
      branch: 'develop',
    });
  });

  it('accepts dropped files and reports unreadable or oversized ones', async () => {
    const { view } = setup();
    const dropzone = view.getByTestId('e2e-prd-dropzone');
    fireEvent.dragOver(dropzone);
    fireEvent.dragLeave(dropzone);
    const broken = file('broken.md', 'x');
    broken.text = () => Promise.reject(new Error('io'));
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [file('dropped.md', 'spec'), broken] },
    });
    expect(await view.findByText('dropped.md')).toBeInTheDocument();
    expect(view.getByText('Não foi possível ler o arquivo broken.md.')).toBeInTheDocument();

    fireEvent.change(view.getByTestId('e2e-prd-input'), {
      target: { files: [file('huge.md', 'x', 3_000_000)] },
    });
    expect(await view.findByText('Não foi possível ler o arquivo huge.md.')).toBeInTheDocument();
    fireEvent.change(view.getByTestId('e2e-prd-input'), { target: { files: null } });
  });

  it('shows API errors and resets the form', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('URL não permitida'))
      .mockRejectedValueOnce('boom');
    const { view } = setup({ create });
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'x' } });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://sample.trycloudflare.com' },
    });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'p' } });
    await chooseRepository(view);
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(await view.findByText('URL não permitida', {}, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(await view.findByText('Não foi possível iniciar a execução.')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Limpar' }));
    expect((view.getByLabelText('Nome da execução') as HTMLInputElement).value).toBe('');
    expect(view.queryByText('Não foi possível iniciar a execução.')).toBeNull();
    expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa');
  });

  it('guides the user when there is no agent and goes back', async () => {
    const onOpenAgents = vi.fn();
    const { view, onCancel } = setup({ agents: new Error('down'), onOpenAgents });
    expect(
      await view.findByText(/Crie um agente em Agents antes de iniciar uma execução./),
    ).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Agentes' }));
    expect(onOpenAgents).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(view.getByText('Selecione um agente.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Limpar' }));
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('falls back to the first agent and hides the shortcut without a handler', async () => {
    const first = setup({ agents: [agents[0]] });
    await waitFor(() =>
      expect((first.view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('doc'),
    );
    first.view.unmount();
    const none = setup({ agents: [] });
    expect(await none.view.findByText(/Crie um agente/)).toBeInTheDocument();
    expect(none.view.queryByRole('button', { name: 'Agentes' })).toBeNull();
  });

  it('ignores agents that arrive after unmount', async () => {
    let resolve!: (value: unknown[]) => void;
    let resolveRepositories!: (value: unknown) => void;
    let resolveBranches!: (value: unknown) => void;
    let rejectBranches!: (reason: unknown) => void;
    const client = {
      getAgents: vi.fn(() => new Promise((done) => (resolve = done))),
      getE2eRepositories: vi
        .fn()
        .mockImplementationOnce(() => new Promise((done) => (resolveRepositories = done)))
        .mockImplementationOnce(() => Promise.reject(new Error('late'))),
      getE2eBranches: vi.fn(),
      createE2eCreation: vi.fn(),
    };
    const view = render(
      <E2eConfigForm
        apiClient={client as unknown as ApiClient}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Limpar' }));
    view.unmount();
    resolve(agents);
    resolveRepositories({ repositories, warnings: [] });
    await Promise.resolve();
    expect(client.getAgents).toHaveBeenCalledOnce();

    // Late repository failures and branch answers after unmount are ignored too.
    const late = render(
      <E2eConfigForm
        apiClient={{ ...client, getAgents: () => Promise.resolve([]) } as unknown as ApiClient}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    late.unmount();
    await Promise.resolve();
    client.getE2eRepositories.mockResolvedValue({ repositories, warnings: [] });
    client.getE2eBranches
      .mockImplementationOnce(() => new Promise((done) => (resolveBranches = done)))
      .mockImplementationOnce(() => new Promise((_done, fail) => (rejectBranches = fail)));
    const branchView = render(
      <E2eConfigForm
        apiClient={{ ...client, getAgents: () => Promise.resolve([]) } as unknown as ApiClient}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        branchView.getByLabelText('Repositório').querySelectorAll('option').length,
      ).toBeGreaterThan(1),
    );
    fireEvent.change(branchView.getByLabelText('Repositório'), { target: { value: 'github:42' } });
    fireEvent.change(branchView.getByLabelText('Repositório'), {
      target: { value: 'azure_devops:guid-1' },
    });
    branchView.unmount();
    resolveBranches([{ name: 'main', isDefault: true }]);
    rejectBranches(new Error('gone'));
    await Promise.resolve();
  });

  it('filters long repository lists by name and keeps the chosen one listed', async () => {
    const { view } = setup();
    const select = view.getByLabelText('Repositório');
    const names = () => [...select.querySelectorAll('option')].map((option) => option.textContent);
    await waitFor(() => expect(names()).toContain('Finance/app'));
    expect(
      view.getByText(/2 repositórios encontrados\. Faltou algum\? Verifique/),
    ).toBeInTheDocument();
    const search = view.getByLabelText('Buscar repositórios');
    fireEvent.change(search, { target: { value: '  FINANCE ' } });
    expect(names()).toEqual(['Selecione um repositório', 'Finance/app']);
    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(names()).toEqual(['Nenhum repositório corresponde à busca']);

    fireEvent.change(search, { target: { value: '' } });
    await chooseRepository(view);
    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(names()).toEqual(['Nenhum repositório corresponde à busca', 'acme/demo-app']);
    expect((select as HTMLSelectElement).value).toBe('github:42');
  });

  it('picks the first branch when none is marked as default', async () => {
    const { view } = setup({ branches: [{ name: 'release', isDefault: false }] });
    await chooseRepository(view, 'github:42', 'release');
  });

  it('explains missing repositories, warnings and branch failures', async () => {
    const onOpenIntegrations = vi.fn();
    const empty = setup({
      repositories: {
        repositories: [],
        warnings: [
          { provider: 'github', code: 'CREDENTIALS_MISSING' },
          { provider: 'azure_devops', code: 'PROVIDER_UNAVAILABLE' },
        ],
      },
      onOpenIntegrations,
    });
    expect(await empty.view.findByText(/Nenhum repositório encontrado/)).toBeInTheDocument();
    expect(empty.view.getByText('GitHub: token ausente na integração.')).toBeInTheDocument();
    expect(
      empty.view.getByText(
        'Azure DevOps: não foi possível listar os repositórios (verifique o token).',
      ),
    ).toBeInTheDocument();
    fireEvent.click(empty.view.getByRole('button', { name: 'Integrações' }));
    expect(onOpenIntegrations).toHaveBeenCalled();
    empty.view.unmount();

    const failed = setup({ repositories: new Error('Sem acesso') });
    expect(await failed.view.findByText(/Sem acesso/)).toBeInTheDocument();
    expect(failed.view.queryByRole('button', { name: 'Integrações' })).toBeNull();
    failed.view.unmount();

    const opaque = render(
      <E2eConfigForm
        apiClient={
          {
            getAgents: () => Promise.resolve([]),
            getE2eRepositories: () =>
              Promise.reject(new Error('Não foi possível carregar os repositórios.')),
            getE2eBranches: vi.fn(),
          } as unknown as ApiClient
        }
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      await opaque.findByText(/Não foi possível carregar os repositórios./),
    ).toBeInTheDocument();
    opaque.unmount();

    const branches = setup({ branches: new Error('Branch indisponível') });
    await waitFor(() =>
      expect(branches.view.getByLabelText('Repositório').querySelectorAll('option').length).toBe(3),
    );
    fireEvent.change(branches.view.getByLabelText('Repositório'), {
      target: { value: 'github:42' },
    });
    expect(await branches.view.findByText('Branch indisponível')).toBeInTheDocument();
    // Without branch data the repository's default branch is still offered.
    await waitFor(() =>
      expect((branches.view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    branches.view.unmount();

    const opaqueBranches = setup({ branches: [] });
    opaqueBranches.client.getE2eBranches.mockRejectedValueOnce('boom');
    await waitFor(() =>
      expect(
        opaqueBranches.view.getByLabelText('Repositório').querySelectorAll('option').length,
      ).toBe(3),
    );
    fireEvent.change(opaqueBranches.view.getByLabelText('Repositório'), {
      target: { value: 'azure_devops:guid-1' },
    });
    expect(
      await opaqueBranches.view.findByText('Não foi possível carregar as branches.'),
    ).toBeInTheDocument();
    fireEvent.change(opaqueBranches.view.getByLabelText('Repositório'), {
      target: { value: '' },
    });
    expect((opaqueBranches.view.getByLabelText('Branch base') as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  it('edits an existing run, keeping its stored password unless retyped', async () => {
    const { client, view, onCreated } = setup({ creationId: 'c1' });
    expect(view.getByText('Editar execução')).toBeInTheDocument();
    await waitFor(() =>
      expect((view.getByLabelText('Nome da execução') as HTMLInputElement).value).toBe('ama'),
    );
    expect(client.getE2eCreation).toHaveBeenCalledWith('c1');
    expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('doc');
    expect((view.getByLabelText('Caminho') as HTMLInputElement).value).toBe('e/123');
    expect((view.getByLabelText('Ou cole o conteúdo') as HTMLTextAreaElement).value).toBe(
      '# prd.md\n\nQuestions',
    );
    expect(view.getByText(/Deixe em branco para manter a senha atual/)).toBeInTheDocument();
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('feature/e2e'),
    );

    // The folder of an existing run no longer follows its name.
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'ama v2' } });
    expect((view.getByLabelText('Pasta dos scripts no projeto') as HTMLInputElement).value).toBe(
      'tests/e2e/ama',
    );
    fireEvent.click(view.getByRole('button', { name: 'Limpar' }));
    expect((view.getByLabelText('Nome da execução') as HTMLInputElement).value).toBe('ama');
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'ama v2' } });
    fireEvent.change(view.getByTestId('e2e-prd-input'), {
      target: { files: [file('prd.md', 'Votes'), file('rules.txt', 'Vote once')] },
    });
    expect(await view.findByText('rules.txt')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1', name: 'saved' }));
    expect(client.createE2eCreation).not.toHaveBeenCalled();
    const [id, input] = client.updateE2eCreation.mock.calls[0]!;
    expect(id).toBe('c1');
    expect(input).toMatchObject({
      name: 'ama v2',
      agentId: 'doc',
      path: 'e/123',
      username: 'qa@example.com',
      prdFileNames: ['prd.md', 'rules.txt'],
      repository: { provider: 'github', id: '42', branch: 'feature/e2e', path: 'tests/e2e/ama' },
    });
    expect(input.prd).toContain('# prd.md\n\nQuestions');
    expect(input).not.toHaveProperty('password');
  });

  it('edits legacy runs without a repository and reports save failures', async () => {
    const update = vi.fn().mockRejectedValue('offline');
    const { view } = setup({
      creationId: 'c1',
      update,
      getCreation: vi.fn().mockResolvedValue(
        existing({
          name: 'Legacy run',
          username: null,
          hasPassword: false,
          scope: 'diff',
          diff: '+ change',
          instructions: 'focus',
          repository: null,
        }),
      ),
    });
    await waitFor(() =>
      expect((view.getByLabelText('Diff do código') as HTMLTextAreaElement).value).toBe('+ change'),
    );
    expect((view.getByLabelText('Instruções extras') as HTMLTextAreaElement).value).toBe('focus');
    expect((view.getByLabelText('Pasta dos scripts no projeto') as HTMLInputElement).value).toBe(
      'tests/e2e/legacy-run',
    );
    expect(view.queryByText(/Deixe em branco/)).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    expect(await view.findByText('Selecione o repositório e a branch.')).toBeInTheDocument();
    await chooseRepository(view);
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    expect(await view.findByText('Não foi possível salvar a execução.')).toBeInTheDocument();
    expect(update.mock.calls[0]![1]).toMatchObject({ scope: 'diff', diff: '+ change' });
  });

  it('retries loading a run that failed to load and ignores late answers', async () => {
    const getCreation = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce('opaque')
      .mockResolvedValue(existing());
    const { view, onCancel } = setup({ creationId: 'c1', getCreation });
    expect(await view.findByText('boom')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText('Não foi possível carregar a execução.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Voltar' }));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect((view.getByLabelText('Nome da execução') as HTMLInputElement).value).toBe('ama'),
    );
    view.unmount();

    const late = deferred<E2eCreationDetail>();
    const resolved = setup({ creationId: 'c1', getCreation: vi.fn(() => late.promise) });
    expect(resolved.view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    resolved.view.unmount();
    late.resolve(existing());
    const failed = deferred<E2eCreationDetail>();
    setup({ creationId: 'c1', getCreation: vi.fn(() => failed.promise) }).view.unmount();
    failed.reject(new Error('late'));
    await act(() => Promise.resolve());
  });
});

describe('E2eConfigForm with test cases saved in ADK', () => {
  async function fillRun(view: ReturnType<typeof render>) {
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('qa'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'Login' } });
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://app.example.com' },
    });
    await chooseRepository(view);
  }

  it('automates chosen cases of a suite and of one of its Test Plans', async () => {
    const { client, view, onCreated } = setup();
    await fillRun(view);
    fireEvent.change(view.getByRole('combobox', { name: 'Origem dos testes' }), {
      target: { value: 'saved' },
    });
    const picker = await view.findByTestId('e2e-saved-case-picker');
    fireEvent.change(within(picker).getByLabelText('Suíte'), { target: { value: 'root' } });
    // The suite brings the cases of its child suites; cases without an id are left out.
    expect(within(picker).getByText('3 de 3 selecionados')).toBeInTheDocument();
    expect(within(picker).queryByText('Legacy')).toBeNull();
    fireEvent.click(within(picker).getByLabelText(/Home loads/));
    expect(within(picker).getByText('2 de 3 selecionados')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(client.createE2eCreation).toHaveBeenLastCalledWith(
      expect.objectContaining({ prd: '', savedCases: { suiteId: 'root', caseIds: ['c1', 'c2'] } }),
    );

    fireEvent.change(within(picker).getByLabelText('Test Plan'), {
      target: { value: 'plan-login' },
    });
    expect(within(picker).getByText('2 de 2 selecionados')).toBeInTheDocument();
    fireEvent.click(within(picker).getByLabelText(/Todos os casos/));
    expect(within(picker).getByText('0 de 2 selecionados')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(
      await view.findByText('Escolha uma suíte ou um Test Plan com pelo menos um caso de teste.'),
    ).toBeInTheDocument();
    fireEvent.click(within(picker).getByLabelText(/Todos os casos/));
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() =>
      expect(client.createE2eCreation).toHaveBeenLastCalledWith(
        expect.objectContaining({ savedCases: { planId: 'plan-login' } }),
      ),
    );
    fireEvent.change(within(picker).getByLabelText('Test Plan'), { target: { value: '' } });
    expect(within(picker).getByText('3 de 3 selecionados')).toBeInTheDocument();
  });

  it('starts from the cases chosen in Test Plans', async () => {
    const { client, view } = setup({
      initialSavedCases: { planId: 'plan-login', caseIds: ['c2'] },
    });
    expect(
      (view.getByRole('combobox', { name: 'Origem dos testes' }) as HTMLSelectElement).value,
    ).toBe('saved');
    const picker = await view.findByTestId('e2e-saved-case-picker');
    expect((within(picker).getByLabelText('Suíte') as HTMLSelectElement).value).toBe('login');
    expect((within(picker).getByLabelText('Test Plan') as HTMLSelectElement).value).toBe(
      'plan-login',
    );
    expect(within(picker).getByText('1 de 2 selecionados')).toBeInTheDocument();
    await fillRun(view);
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    await waitFor(() =>
      expect(client.createE2eCreation).toHaveBeenCalledWith(
        expect.objectContaining({ savedCases: { planId: 'plan-login', caseIds: ['c2'] } }),
      ),
    );
    // Resetting keeps the cases the form was opened with.
    fireEvent.click(view.getByRole('button', { name: 'Limpar' }));
    expect(
      (view.getByRole('combobox', { name: 'Origem dos testes' }) as HTMLSelectElement).value,
    ).toBe('saved');
  });

  it('explains when there is nothing saved to automate', async () => {
    const empty = setup({ savedPlans: [] });
    fireEvent.change(empty.view.getByRole('combobox', { name: 'Origem dos testes' }), {
      target: { value: 'saved' },
    });
    expect(await empty.view.findByText(/Ainda não há Test Plans salvos/)).toBeInTheDocument();
    empty.view.unmount();

    const failing = setup({ savedPlans: new Error('offline') });
    fireEvent.change(failing.view.getByRole('combobox', { name: 'Origem dos testes' }), {
      target: { value: 'saved' },
    });
    expect(await failing.view.findByText('offline')).toBeInTheDocument();
    failing.view.unmount();

    const { view } = setup({ initialSavedCases: { suiteId: 'other' } });
    expect(await view.findByText('Nenhum caso de teste salvo aqui.')).toBeInTheDocument();
  });
});

describe('E2eSavedCasePicker', () => {
  it('rechecks cases and ignores answers that arrive after closing', async () => {
    const { view } = setup({ initialSavedCases: { planId: 'plan-login' } });
    const picker = await view.findByTestId('e2e-saved-case-picker');
    fireEvent.click(within(picker).getByLabelText(/Wrong password/));
    expect(within(picker).getByText('1 de 2 selecionados')).toBeInTheDocument();
    fireEvent.click(within(picker).getByLabelText(/Wrong password/));
    expect(within(picker).getByText('2 de 2 selecionados')).toBeInTheDocument();
    view.unmount();

    const late = deferred<unknown[]>();
    setup({ initialSavedCases: { suiteId: 'root' }, savedPlans: late.promise }).view.unmount();
    late.resolve(SAVED_PLANS);
    const failing = deferred<unknown[]>();
    setup({ initialSavedCases: { suiteId: 'root' }, savedPlans: failing.promise }).view.unmount();
    failing.reject('gone');
    await act(() => Promise.resolve());
  });
});

describe('E2eConfigForm default execution', () => {
  const selected = (view: ReturnType<typeof setup>['view'], name: string) =>
    view.getByRole('radio', { name }).getAttribute('aria-checked') === 'true';

  it('starts a new run on the user computer when the server prefers it', async () => {
    const { view, client } = setup({ defaultExecutionTarget: 'local' });
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(selected(view, 'Meu computador')).toBe(true));
    expect(selected(view, 'Servidores do ADK')).toBe(false);
  });

  it('keeps the ADK workers for a new run when that is the default', async () => {
    const { view, client } = setup({ defaultExecutionTarget: 'remote' });
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    expect(selected(view, 'Servidores do ADK')).toBe(true);
  });

  it('does not move a run being edited to the default', async () => {
    const { view, client } = setup({ creationId: 'c1', defaultExecutionTarget: 'local' });
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(client.getE2eCreation).toHaveBeenCalled());
    await view.findByDisplayValue('ama');
    expect(selected(view, 'Servidores do ADK')).toBe(true);
  });
});

describe('E2eConfigForm in a local install', () => {
  it('lets the ADK workers open a localhost target, without a tunnel or the local runner', async () => {
    const { view, client } = setup({ workersReachLocalhost: true });
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'http://localhost:5173/login' },
    });
    expect(
      await view.findByText(
        'O ADK roda neste computador, então os workers do ADK abrem este endereço localhost diretamente, com a origem localhost.',
      ),
    ).toBeInTheDocument();
    expect(view.queryByText('Aplicação rodando localmente')).toBeNull();
  });

  it('points to the local runner when the workers cannot reach localhost', async () => {
    const { view, client } = setup({ workersReachLocalhost: false });
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'http://localhost:5173/login' },
    });
    expect(view.getByRole('status')).toHaveTextContent(/Escolha “Meu computador” acima/);
    expect(view.queryByRole('button', { name: /Iniciar o túnel/ })).toBeNull();
  });

  it('treats a server without the capabilities call as one whose workers cannot', async () => {
    const { view, client } = setup();
    client.getCapabilities.mockRejectedValue(new Error('404'));
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'http://localhost:5173/login' },
    });
    expect(view.getByRole('status')).toHaveTextContent(/Escolha “Meu computador” acima/);
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
  });
});

describe('E2eConfigForm in the desktop app', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'adkDesktop', {
      value: { apiUrl: 'http://127.0.0.1:60675' },
      configurable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'adkDesktop');
  });

  it('hides where the tests run, the runner and the tunnel settings', async () => {
    const { view, client } = setup({
      workersReachLocalhost: true,
      defaultExecutionTarget: 'local',
    });
    await waitFor(() => expect(client.getCapabilities).toHaveBeenCalled());
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'http://localhost:3000' },
    });
    expect(view.queryByRole('radio', { name: 'Servidores do ADK' })).toBeNull();
    expect(view.queryByRole('radio', { name: 'Meu computador' })).toBeNull();
    expect(view.queryByText('devkit runner')).toBeNull();
    expect(view.queryByText('Aplicação rodando localmente')).toBeNull();
    expect(view.queryByRole('button', { name: /Autenticação do túnel/ })).toBeNull();
    expect(view.getByText('Mantenha a aplicação ativa durante os testes.')).toBeInTheDocument();
  });

  it('runs a run saved for the local runner on this computer', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'c1', name: 'saved' });
    const { view } = setup({
      creationId: 'c1',
      update,
      workersReachLocalhost: true,
      getCreation: vi
        .fn()
        .mockResolvedValue(
          existing({ baseUrl: 'http://localhost:3000', executionTarget: 'local' }),
        ),
    });
    await view.findByDisplayValue('ama');
    expect(view.queryByText('devkit runner')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ executionTarget: 'remote' }),
    );
  });
});
