import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  E2eImportCasesDialog,
  E2eReportingDialog,
  E2eReportStatus,
} from '../src/features/e2e/E2eTestManagement.js';
import type { E2eCreationSummary, E2eImportResult } from '../src/features/e2e/e2e-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const creation: E2eCreationSummary = {
  id: 'run-1',
  agentId: 'agent-1',
  name: 'Empresas',
  mode: 'frontend',
  scope: 'codebase',
  baseUrl: 'https://example.test',
  path: '/',
  username: null,
  hasPassword: false,
  prdFileNames: [],
  repository: null,
  reporting: null,
  lastReport: null,
  status: 'completed',
  error: null,
  createdAt: '2026-10-07T10:00:00Z',
  updatedAt: '2026-10-07T10:01:00Z',
  finishedAt: '2026-10-07T10:01:00Z',
  passed: 0,
  total: 0,
  tests: [],
};

function api() {
  return {
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
        caseId: '50605',
        planId: '1',
        suiteId: '2',
        title: 'Permissões de Empresas',
        steps: [{ id: '2', action: 'Abrir grupos', expectedResult: 'Grupos visíveis' }],
      },
    ]),
    setE2eReporting: vi.fn().mockResolvedValue(undefined),
    importE2eCases: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, creation }),
  };
}

async function chooseLocation() {
  fireEvent.change(screen.getByLabelText('Plataforma'), { target: { value: 'azure_devops' } });
  await screen.findByRole('option', { name: 'Empresas' });
  fireEvent.change(screen.getByLabelText('Test Plan'), { target: { value: '1' } });
  await screen.findByRole('option', { name: 'Permissões' });
  fireEvent.change(screen.getByLabelText('Suite'), { target: { value: '2' } });
}

describe('E2E test management UI', () => {
  it('saves the selected platform and location for automatic publication', async () => {
    const client = api();
    const onSaved = vi.fn();
    render(
      <E2eReportingDialog
        apiClient={client as unknown as ApiClient}
        creation={creation}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await screen.findByLabelText('Plataforma');
    await chooseLocation();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.setE2eReporting).toHaveBeenCalledWith('run-1', {
        provider: 'azure_devops',
        planId: '1',
        suiteId: '2',
        autoPublish: true,
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('imports only the selected test case', async () => {
    const client = api();
    const onImported = vi.fn<(result: E2eImportResult) => void>();
    render(
      <E2eImportCasesDialog
        apiClient={client as unknown as ApiClient}
        creation={creation}
        onClose={vi.fn()}
        onImported={onImported}
      />,
    );
    await screen.findByLabelText('Plataforma');
    await chooseLocation();
    await screen.findByText('Permissões de Empresas');
    fireEvent.click(screen.getByLabelText(/50605/));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Importar (1)' }));
    });
    await waitFor(() =>
      expect(client.importE2eCases).toHaveBeenCalledWith('run-1', {
        provider: 'azure_devops',
        planId: '1',
        suiteId: '2',
        caseIds: ['50605'],
      }),
    );
    expect(onImported).toHaveBeenCalledOnce();
  });

  it('shows the published run link and attachment warnings', () => {
    render(
      <E2eReportStatus
        report={{
          status: 'published',
          provider: 'azure_devops',
          remoteRunId: '1037128',
          url: 'https://dev.azure.com/example/run/1037128',
          publishedCases: 1,
          warnings: ['Could not attach image.png'],
          error: null,
          updatedAt: '2026-10-07T10:02:00Z',
        }}
      />,
    );
    expect(screen.getByRole('link').getAttribute('href')).toContain('1037128');
    expect(screen.getByText('Could not attach image.png')).toBeTruthy();
  });
});
