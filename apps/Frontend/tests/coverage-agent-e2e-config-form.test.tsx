import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eConfigForm } from '../src/features/e2e/E2eConfigForm.js';
import type { E2eCreationDetail } from '../src/features/e2e/e2e-types.js';
import { LocalHelperError, localTunnelBridge } from '../src/features/e2e/local-tunnel-bridge.js';
import type * as TunnelBridge from '../src/features/e2e/local-tunnel-bridge.js';
import type { ApiClient } from '../src/lib/api-client.js';

vi.mock('../src/features/e2e/local-tunnel-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TunnelBridge>()),
  localTunnelBridge: { start: vi.fn(), status: vi.fn(), stop: vi.fn() },
}));

const existing: E2eCreationDetail = {
  id: 'c1',
  agentId: 'qa',
  name: 'ama',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'https://app.example.com',
  path: '/',
  username: null,
  hasPassword: false,
  hasAccessServiceToken: true,
  reporting: null,
  lastReport: null,
  prdFileNames: [],
  repository: {
    provider: 'github',
    id: '42',
    name: 'acme/demo-app',
    branch: 'main',
    path: 'tests/e2e/ama',
  },
  status: 'completed',
  error: null,
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:36:00Z',
  finishedAt: '2026-01-30T09:36:00Z',
  tests: [],
  prd: 'Questions',
  diff: null,
  instructions: null,
};

const azure = {
  id: 'azure_devops',
  name: 'Azure DevOps Test Plans',
  configured: true,
  capabilities: {
    planLabel: 'Test Plan',
    suiteLabel: 'Suite',
    suiteRequired: true,
    caseIdLabel: 'Test Case ID',
    stepEvidence: true,
  },
};

function setup(options: { creationId?: string; providers?: unknown[] } = {}) {
  const client = {
    apiUrl: 'https://api.adk.example.com',
    getE2eRunners: vi.fn().mockResolvedValue([]),
    getAgents: vi.fn().mockResolvedValue([{ id: 'qa', name: 'QA Engineer', role: 'QA' }]),
    getE2eRepositories: vi.fn().mockResolvedValue({
      repositories: [
        { id: '42', provider: 'github', name: 'acme/demo-app', defaultBranch: 'main' },
      ],
      warnings: [],
    }),
    getE2eBranches: vi.fn().mockResolvedValue([{ name: 'main', isDefault: true }]),
    checkE2eTunnel: vi.fn().mockResolvedValue({ reachable: true, reason: 'ok', status: 200 }),
    createE2eCreation: vi.fn().mockResolvedValue({ id: 'new' }),
    getE2eCreation: vi.fn().mockResolvedValue(existing),
    updateE2eCreation: vi.fn().mockResolvedValue({ id: 'c1' }),
    getTestManagementProviders: vi.fn().mockResolvedValue(options.providers ?? [azure]),
    getTestManagementPlans: vi.fn().mockResolvedValue([{ id: '1', name: 'Empresas' }]),
    getTestManagementSuites: vi.fn().mockResolvedValue([{ id: '2', name: 'Permissões' }]),
    getTestManagementCases: vi.fn().mockResolvedValue([
      {
        provider: 'azure_devops',
        caseId: '50605',
        planId: '1',
        suiteId: '2',
        title: 'Permissões de Empresas',
        steps: [],
      },
    ]),
  };
  const onCreated = vi.fn();
  render(
    <E2eConfigForm
      apiClient={client as unknown as ApiClient}
      creationId={options.creationId}
      onCreated={onCreated}
      onCancel={vi.fn()}
    />,
  );
  return { client, onCreated };
}

async function chooseRepository() {
  await waitFor(() =>
    expect(screen.getByLabelText('Repositório').querySelectorAll('option').length).toBeGreaterThan(
      1,
    ),
  );
  fireEvent.change(screen.getByLabelText('Repositório'), { target: { value: 'github:42' } });
  await waitFor(() =>
    expect((screen.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
  );
}

const startTunnel = () =>
  fireEvent.click(screen.getByRole('button', { name: /Iniciar t.nel no meu computador/ }));

describe('E2eConfigForm local helper failures', () => {
  it('reports a helper that answered without a tunnel', async () => {
    vi.mocked(localTunnelBridge.start).mockResolvedValueOnce({ tunnel: null });
    setup();
    startTunnel();
    expect(await screen.findByText('Tunnel did not start.')).toBeInTheDocument();
    expect(screen.getByText(/O auxiliar local não conseguiu abrir o túnel/)).toBeInTheDocument();
  });

  it('stops a tunnel of an outdated helper that cannot route local services', async () => {
    vi.mocked(localTunnelBridge.stop).mockRejectedValueOnce(new Error('already stopped'));
    vi.mocked(localTunnelBridge.start).mockResolvedValueOnce({
      tunnel: { localUrl: 'http://localhost:3000', publicUrl: 'https://old.trycloudflare.com' },
    });
    const { client } = setup();
    startTunnel();
    expect(
      await screen.findByText(/Esta versão do auxiliar local não conecta vários serviços/),
    ).toBeInTheDocument();
    expect(localTunnelBridge.stop).toHaveBeenCalledOnce();
    expect(client.checkE2eTunnel).not.toHaveBeenCalled();
    expect((screen.getByLabelText('URL base') as HTMLInputElement).value).toBe(
      'http://localhost:3000',
    );
  });

  it('shows unexpected helper failures as they are', async () => {
    vi.mocked(localTunnelBridge.start).mockRejectedValueOnce('socket hang up');
    setup();
    startTunnel();
    expect(await screen.findByText('socket hang up')).toBeInTheDocument();
  });

  it('keeps an unreachable helper error when the status check answers', async () => {
    vi.mocked(localTunnelBridge.start).mockRejectedValueOnce(
      new LocalHelperError('unreachable', 'Local tunnel helper is unavailable.'),
    );
    vi.mocked(localTunnelBridge.status).mockResolvedValueOnce({ tunnel: null });
    setup();
    startTunnel();
    expect(
      await screen.findByText(/Não foi possível acessar o auxiliar local/),
    ).toBeInTheDocument();
    expect(localTunnelBridge.status).toHaveBeenCalled();
  });

  it('keeps an unreachable helper error when the status check fails unexpectedly', async () => {
    vi.mocked(localTunnelBridge.start).mockRejectedValueOnce(
      new LocalHelperError('unreachable', 'Local tunnel helper is unavailable.'),
    );
    vi.mocked(localTunnelBridge.status).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup();
    startTunnel();
    expect(
      await screen.findByText(/Não foi possível acessar o auxiliar local/),
    ).toBeInTheDocument();
  });
});

describe('E2eConfigForm tunnel tools', () => {
  it('explains when the tunnel command cannot be copied', async () => {
    setup();
    fireEvent.click(
      screen.getByRole('button', { name: /Configurar o auxiliar ou iniciar o túnel manualmente/ }),
    );
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Copiar comando' }));
    expect(
      await screen.findByText('Não foi possível copiar. Selecione e copie o comando acima.'),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('devkit tunnel --url http://localhost:3000');
  });

  it('asks to try again when the connection check request fails', async () => {
    const { client } = setup();
    client.checkE2eTunnel.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getByLabelText('URL base'), {
      target: { value: 'https://app.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar conexão' }));
    expect(
      await screen.findByText('Não foi possível verificar a URL agora. Tente novamente.'),
    ).toBeInTheDocument();
  });
});

describe('E2eConfigForm access token', () => {
  it('removes the saved access token of an edited run', async () => {
    const { client, onCreated } = setup({ creationId: 'c1' });
    const settings = await screen.findByRole('button', {
      name: /Autenticação do túnel \(opcional\)/,
    });
    expect(settings).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Token salvo')).toBeInTheDocument();
    expect(screen.getByLabelText('Access Client Secret')).toHaveAttribute(
      'placeholder',
      '••••••••',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remover token salvo' }));
    expect(screen.getByText('O token salvo será removido ao salvar.')).toBeInTheDocument();
    expect(screen.queryByText('Token salvo')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover token salvo' })).toBeNull();
    await waitFor(() =>
      expect((screen.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'c1' }));
    expect(client.updateE2eCreation.mock.calls[0]![1]).toMatchObject({
      clearAccessServiceToken: true,
    });
  });

  it('sends a new access token with a new run', async () => {
    const { client, onCreated } = setup();
    fireEvent.change(screen.getByLabelText('Nome da execução'), { target: { value: 'ama' } });
    fireEvent.change(screen.getByLabelText('URL base'), {
      target: { value: 'https://app.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Ou cole o conteúdo'), {
      target: { value: 'Questions' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Autenticação do túnel \(opcional\)/ }));
    expect(screen.getByLabelText('Access Client Secret')).toHaveAttribute(
      'placeholder',
      'Access Client Secret',
    );
    fireEvent.change(screen.getByLabelText('Access Client ID'), { target: { value: ' id ' } });
    fireEvent.change(screen.getByLabelText('Access Client Secret'), {
      target: { value: ' secret ' },
    });
    await chooseRepository();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'new' }));
    expect(client.createE2eCreation.mock.calls[0]![0]).toMatchObject({
      accessClientId: 'id',
      accessClientSecret: 'secret',
    });
    expect(client.createE2eCreation.mock.calls[0]![0]).not.toHaveProperty(
      'clearAccessServiceToken',
    );
  });
});

describe('E2eConfigForm platform cases', () => {
  it('requires a case and imports the chosen cases with the run', async () => {
    const { client, onCreated } = setup();
    fireEvent.change(screen.getByLabelText('Nome da execução'), { target: { value: 'ama' } });
    fireEvent.change(screen.getByLabelText('URL base'), {
      target: { value: 'https://app.example.com' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Test cases da plataforma' }));
    expect(screen.getByTestId('e2e-case-picker')).toBeInTheDocument();
    await chooseRepository();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Selecione ao menos um test case.')).toBeInTheDocument();
    expect(client.createE2eCreation).not.toHaveBeenCalled();

    fireEvent.change(await screen.findByLabelText('Plataforma'), {
      target: { value: 'azure_devops' },
    });
    await screen.findByRole('option', { name: 'Empresas' });
    fireEvent.change(screen.getByLabelText('Test Plan'), { target: { value: '1' } });
    await screen.findByRole('option', { name: 'Permissões' });
    fireEvent.change(screen.getByLabelText('Suite'), { target: { value: '2' } });
    fireEvent.click(await screen.findByLabelText(/50605/));
    expect(screen.queryByText('Selecione ao menos um test case.')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'new' }));
    expect(client.createE2eCreation.mock.calls[0]![0]).toMatchObject({
      prd: '',
      importCases: {
        provider: 'azure_devops',
        planId: '1',
        suiteId: '2',
        caseIds: ['50605'],
      },
    });
  });

  it('imports cases of a platform without suites', async () => {
    const { client, onCreated } = setup({
      providers: [
        {
          id: 'xray',
          name: 'Xray Cloud',
          configured: true,
          capabilities: { planLabel: 'Projeto Jira', caseIdLabel: 'Issue', stepEvidence: false },
        },
      ],
    });
    client.getTestManagementCases.mockResolvedValue([
      { provider: 'xray', caseId: 'QA-1', planId: 'QA', title: 'Login', steps: [] },
    ]);
    fireEvent.change(screen.getByLabelText('Nome da execução'), { target: { value: 'ama' } });
    fireEvent.change(screen.getByLabelText('URL base'), {
      target: { value: 'https://app.example.com' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Test cases da plataforma' }));
    fireEvent.change(await screen.findByLabelText('Plataforma'), { target: { value: 'xray' } });
    await screen.findByRole('option', { name: 'Empresas' });
    fireEvent.change(screen.getByLabelText('Projeto Jira'), { target: { value: '1' } });
    fireEvent.click(await screen.findByLabelText(/QA-1/));
    await chooseRepository();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'new' }));
    expect(client.createE2eCreation.mock.calls[0]![0].importCases).toEqual({
      provider: 'xray',
      planId: '1',
      caseIds: ['QA-1'],
    });
  });
});
