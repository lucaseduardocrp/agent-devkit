import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { E2eView } from '../src/features/e2e/E2eView.js';
import type { E2eCreationSummary, E2eTestSummary } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const test: E2eTestSummary = {
  id: 't1',
  creationId: 'c1',
  position: 1,
  code: 'TC001',
  title: 'Permissões',
  description: 'Validar permissões.',
  steps: ['Abrir grupos'],
  priority: 'high',
  scriptPath: 'tests/e2e/tc001.spec.ts',
  status: 'passed',
  error: null,
  analysis: null,
  verdict: null,
  durationMs: 1200,
  attempts: 1,
  hasVideo: false,
  externalCase: {
    provider: 'azure_devops',
    caseId: '50605',
    title: 'Permissões de Empresas',
    steps: [],
  },
  stepResults: [],
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:24:00Z',
  lastRunAt: '2026-01-30T09:24:00Z',
};

const run: E2eCreationSummary = {
  id: 'c1',
  agentId: 'a1',
  name: 'ama',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'https://app.example.test',
  path: '/',
  username: null,
  hasPassword: false,
  reporting: { provider: 'azure_devops', planId: '1', suiteId: '2', autoPublish: true },
  lastReport: null,
  prdFileNames: [],
  repository: null,
  status: 'completed',
  error: null,
  createdAt: '2026-01-30T09:23:00Z',
  updatedAt: '2026-01-30T09:36:00Z',
  finishedAt: '2026-01-30T09:36:00Z',
  passed: 1,
  total: 1,
  tests: [test],
};

function api() {
  return {
    getE2eCreations: vi.fn().mockResolvedValue([run]),
    publishE2eCreation: vi.fn().mockResolvedValue(run),
    getTestManagementProviders: vi.fn().mockResolvedValue([
      {
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
      },
    ]),
    getTestManagementPlans: vi.fn().mockResolvedValue([{ id: '1', name: 'Empresas' }]),
    getTestManagementSuites: vi.fn().mockResolvedValue([{ id: '2', name: 'Permissões' }]),
    getTestManagementCases: vi.fn().mockResolvedValue([
      {
        provider: 'azure_devops',
        caseId: '50606',
        planId: '1',
        suiteId: '2',
        title: 'Excluir empresa',
        steps: [],
      },
    ]),
    setE2eReporting: vi.fn().mockResolvedValue(undefined),
    importE2eCases: vi.fn().mockResolvedValue({ imported: 1, skipped: 2, creation: run }),
  };
}

async function setup() {
  const client = api();
  render(<E2eView apiClient={client as unknown as ApiClient} />);
  await screen.findByText('TC001-Permissões');
  return client;
}

/** Managing test management and importing cases are actions of the run menu. */
async function chooseRunAction(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

describe('E2eView test management', () => {
  it('shows the case linked to each test', async () => {
    await setup();
    const row = screen.getByText('TC001-Permissões').closest('td') as HTMLElement;
    expect(within(row).getByText('50605')).toBeInTheDocument();
  });

  it('publishes the latest results and reloads the runs', async () => {
    const client = await setup();
    fireEvent.click(screen.getByRole('button', { name: /Publicar run/ }));
    await waitFor(() => expect(client.publishE2eCreation).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(client.getE2eCreations).toHaveBeenCalledTimes(2));
  });

  it('saves the reporting target and tells the user', async () => {
    const client = await setup();
    await chooseRunAction(/Gestão de testes/);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Gestão de testes · ama')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await chooseRunAction(/Gestão de testes/);
    await within(await screen.findByRole('dialog')).findByRole('option', { name: 'Permissões' });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Gestão de testes de "ama" atualizada.')).toBeInTheDocument();
    expect(client.setE2eReporting).toHaveBeenCalledWith('c1', {
      provider: 'azure_devops',
      planId: '1',
      suiteId: '2',
      autoPublish: true,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(client.getE2eCreations).toHaveBeenCalledTimes(2));
  });

  it('imports cases into the run and reports how many were added', async () => {
    const client = await setup();
    await chooseRunAction(/Importar test cases/);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await chooseRunAction(/Importar test cases/);
    fireEvent.click(await within(await screen.findByRole('dialog')).findByLabelText(/50606/));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Importar (1)' }));
    });
    expect(
      await screen.findByText('1 test cases importados em "ama" (2 já estavam na execução).'),
    ).toBeInTheDocument();
    expect(client.importE2eCases).toHaveBeenCalledWith('c1', {
      provider: 'azure_devops',
      planId: '1',
      suiteId: '2',
      caseIds: ['50606'],
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
