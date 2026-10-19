import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportTestCasesModal } from '../src/features/testplans/ImportTestCasesModal.js';
import type { ApiClient, ImportTestCasesResultDto } from '../src/lib/api-client.js';
import type { TestManagementProvider } from '../src/features/e2e/e2e-types.js';

const AZURE: TestManagementProvider = {
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
const XRAY: TestManagementProvider = {
  id: 'xray',
  name: 'Xray Cloud',
  configured: true,
  capabilities: { ...AZURE.capabilities, suiteLabel: null, suiteRequired: false },
};

const RESULT: ImportTestCasesResultDto = {
  rootSuiteId: 'local-root',
  suitesCreated: 2,
  plans: [],
  created: 3,
  updated: 1,
};

function client(providers: TestManagementProvider[] = [AZURE]) {
  return {
    getTestManagementProviders: vi.fn().mockResolvedValue(providers),
    getTestManagementPlans: vi.fn().mockResolvedValue([{ id: '10', name: 'Sprint 10' }]),
    getTestManagementSuites: vi.fn().mockResolvedValue([
      { id: '1', name: 'Sprint 10' },
      { id: '2', name: 'Login', parentId: '1' },
      { id: '3', name: 'Errors', parentId: '2' },
    ]),
    getTestManagementCases: vi.fn().mockResolvedValue([
      { provider: 'azure_devops', caseId: '200', title: 'Valid login', steps: [] },
      { provider: 'azure_devops', caseId: '201', title: 'Wrong password', steps: [] },
    ]),
    importTestCases: vi.fn().mockResolvedValue(RESULT),
  };
}

function view(api = client(), suite?: { id: string; name: string }) {
  const onImported = vi.fn();
  const onClose = vi.fn();
  const onOpenIntegrations = vi.fn();
  const ui = render(
    <ImportTestCasesModal
      apiClient={api as unknown as ApiClient}
      suite={suite ? { ...suite, workspaceId: 'ws', createdAt: '', updatedAt: '' } : undefined}
      onClose={onClose}
      onImported={onImported}
      onOpenIntegrations={onOpenIntegrations}
    />,
  );
  return { ui, api, onImported, onClose, onOpenIntegrations };
}

async function choosePlan(ui: ReturnType<typeof render>) {
  await waitFor(() =>
    expect((ui.getByLabelText('Provedor') as HTMLSelectElement).value).toBe('azure_devops'),
  );
  await waitFor(() =>
    expect(ui.getByLabelText('Test Plan').querySelectorAll('option')).toHaveLength(2),
  );
  fireEvent.change(ui.getByLabelText('Test Plan'), { target: { value: '10' } });
}

describe('ImportTestCasesModal', () => {
  it('imports a whole plan into new suites and reports the result', async () => {
    const { ui, api, onImported } = view();
    await choosePlan(ui);
    expect(ui.queryByText(/A hierarquia de suítes é mantida/)).toBeNull();
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));

    await waitFor(() =>
      expect(api.importTestCases).toHaveBeenCalledWith({
        providerId: 'azure_devops',
        planId: '10',
      }),
    );
    const result = await ui.findByTestId('import-test-cases-result');
    expect(result).toHaveTextContent(
      '4 casos importados em 0 Test Plans: 3 novos e 1 atualizados.',
    );
    expect(result).toHaveTextContent('2 suítes criadas no ADK.');
    fireEvent.click(ui.getByRole('button', { name: 'Concluir' }));
    expect(onImported).toHaveBeenCalledWith(RESULT);
  });

  it('imports chosen cases of one suite into the suite it was opened from', async () => {
    const { ui, api } = view(client(), { id: 'local-1', name: 'Regression' });
    await choosePlan(ui);
    fireEvent.click(ui.getByLabelText('Uma Suite'));
    await waitFor(() =>
      expect(api.getTestManagementSuites).toHaveBeenCalledWith('azure_devops', '10'),
    );
    const suite = ui.getByLabelText('Suite');
    // Nested suites are indented in the picker.
    expect(within(suite).getByRole('option', { name: /Errors/ }).textContent).toMatch(
      /^\s{4}Errors/,
    );
    fireEvent.change(suite, { target: { value: '2' } });
    fireEvent.click(ui.getByLabelText('Incluir as suítes filhas'));
    expect(await ui.findByText('Wrong password')).toBeInTheDocument();
    expect(ui.getByText('2 de 2 selecionados')).toBeInTheDocument();
    fireEvent.click(ui.getByLabelText(/Valid login/));
    expect(ui.getByText('1 de 2 selecionados')).toBeInTheDocument();
    expect((ui.getByLabelText(/Dentro da suíte "Regression"/) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));
    await waitFor(() =>
      expect(api.importTestCases).toHaveBeenCalledWith({
        providerId: 'azure_devops',
        planId: '10',
        suiteId: '2',
        includeChildSuites: false,
        localSuiteId: 'local-1',
        caseIds: ['201'],
      }),
    );
  });

  it('can send a suite import to a new suite and needs at least one case', async () => {
    const { ui, api } = view(client(), { id: 'local-1', name: 'Regression' });
    await choosePlan(ui);
    fireEvent.click(ui.getByLabelText('Uma Suite'));
    await waitFor(() =>
      expect(ui.getByLabelText('Suite').querySelectorAll('option')).toHaveLength(4),
    );
    fireEvent.change(ui.getByLabelText('Suite'), { target: { value: '3' } });
    await ui.findByText('Valid login');
    // Errors has no child suite, so there is nothing to include.
    expect(ui.queryByLabelText('Incluir as suítes filhas')).toBeNull();
    fireEvent.click(ui.getByLabelText(/Todos os casos/));
    expect((ui.getByTestId('btn-import-test-cases') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ui.getByLabelText(/Todos os casos/));
    fireEvent.click(ui.getByLabelText(/Em uma suíte nova/));
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));
    await waitFor(() =>
      expect(api.importTestCases).toHaveBeenCalledWith({
        providerId: 'azure_devops',
        planId: '10',
        suiteId: '3',
        includeChildSuites: true,
      }),
    );
  });

  it('lists the cases of a plan on platforms without suites', async () => {
    const api = client([XRAY, { ...AZURE, configured: false }]);
    const { ui } = view(api);
    await waitFor(() =>
      expect((ui.getByLabelText('Provedor') as HTMLSelectElement).value).toBe('xray'),
    );
    await waitFor(() =>
      expect(ui.getByLabelText('Test Plan').querySelectorAll('option')).toHaveLength(2),
    );
    fireEvent.change(ui.getByLabelText('Test Plan'), { target: { value: '10' } });
    expect(await ui.findByText('Valid login')).toBeInTheDocument();
    expect(api.getTestManagementCases).toHaveBeenCalledWith('xray', { planId: '10' });
    expect(api.getTestManagementSuites).not.toHaveBeenCalled();
    expect(ui.queryByText('O que importar')).toBeNull();
  });

  it('shows an empty suite, import failures and closes on cancel', async () => {
    const api = client();
    api.getTestManagementCases.mockResolvedValue([]);
    api.importTestCases.mockRejectedValue(new Error('Too many cases'));
    const { ui, onClose } = view(api);
    await choosePlan(ui);
    fireEvent.click(ui.getByLabelText('Uma Suite'));
    await waitFor(() =>
      expect(ui.getByLabelText('Suite').querySelectorAll('option')).toHaveLength(4),
    );
    fireEvent.change(ui.getByLabelText('Suite'), { target: { value: '1' } });
    expect(await ui.findByText('Nenhum caso encontrado.')).toBeInTheDocument();
    fireEvent.click(ui.getByLabelText(/Test Plan inteiro/));
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));
    expect(await ui.findByRole('alert')).toHaveTextContent('Too many cases');
    fireEvent.click(ui.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('points to the integrations when no provider is configured', async () => {
    const { ui, onOpenIntegrations } = view(client([{ ...AZURE, configured: false }]));
    fireEvent.click(await ui.findByRole('button', { name: 'Configurar integrações' }));
    expect(onOpenIntegrations).toHaveBeenCalled();
  });

  it('switches providers, reselects cases and destinations, and closes the result', async () => {
    const api = client([AZURE, XRAY]);
    api.importTestCases.mockRejectedValueOnce('denied');
    const { ui, onImported } = view(api, { id: 'local-1', name: 'Regression' });
    await waitFor(() =>
      expect(ui.getByLabelText('Provedor').querySelectorAll('option')).toHaveLength(3),
    );
    fireEvent.change(ui.getByLabelText('Provedor'), { target: { value: 'xray' } });
    await waitFor(() => expect(api.getTestManagementPlans).toHaveBeenCalledWith('xray'));
    fireEvent.change(ui.getByLabelText('Provedor'), { target: { value: 'azure_devops' } });
    await choosePlan(ui);
    fireEvent.click(ui.getByLabelText('Uma Suite'));
    await waitFor(() =>
      expect(ui.getByLabelText('Suite').querySelectorAll('option')).toHaveLength(4),
    );
    fireEvent.change(ui.getByLabelText('Suite'), { target: { value: '3' } });
    fireEvent.click(await ui.findByLabelText(/Valid login/));
    fireEvent.click(ui.getByLabelText(/Valid login/));
    expect(ui.getByText('2 de 2 selecionados')).toBeInTheDocument();
    fireEvent.click(ui.getByLabelText(/Em uma suíte nova/));
    fireEvent.click(ui.getByLabelText(/Dentro da suíte "Regression"/));
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));
    expect(await ui.findByRole('alert')).toHaveTextContent('denied');
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));
    await ui.findByTestId('import-test-cases-result');
    expect(api.importTestCases).toHaveBeenLastCalledWith(
      expect.objectContaining({ localSuiteId: 'local-1' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onImported).toHaveBeenCalledWith(RESULT);
  });

  it('reports providers that fail to load', async () => {
    const api = client();
    api.getTestManagementProviders.mockRejectedValue(new Error('offline'));
    const { ui } = view(api);
    expect(await ui.findByRole('alert')).toHaveTextContent('offline');
  });
});
