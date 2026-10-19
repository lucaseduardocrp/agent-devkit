import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';

const ISO = '2026-10-14T00:00:00.000Z';

const SUITE: TestSuiteDto = {
  id: 'suite-1',
  workspaceId: 'ws-1',
  name: 'Sprint 10',
  createdAt: ISO,
  updatedAt: ISO,
};

const IMPORTED: SavedTestPlanDto = {
  id: 'plan-1',
  workspaceId: 'ws-1',
  title: 'Login',
  suiteId: 'suite-1',
  sourceType: 'test_management',
  sourceId: 'azure_devops:10:2',
  plans: [
    {
      title: 'Valid login',
      description: '<p>Sign in with a valid account</p>',
      steps: [{ order: 1, action: 'Sign in', expectedResult: 'Home shown' }],
      metadata: {
        caseId: 'case-1',
        importedFrom: 'azure_devops',
        remoteCaseIds: { azure_devops: '50605' },
        customFields: { azure_devops: { 'Custom.Risk': 'High' } },
        customFieldLabels: { azure_devops: { 'Custom.Risk': 'Risk' } },
      },
    },
  ],
  createdAt: ISO,
  updatedAt: ISO,
};

function workspaces(permissions: Record<string, unknown> = {}, role = 'ADMIN') {
  return [
    {
      workspace: { id: 'ws-1', name: 'Workspace', slug: 'ws', ownerId: 'u1', createdAt: '' },
      member: {
        id: 'm1',
        workspaceId: 'ws-1',
        userId: 'u1',
        role: role as 'ADMIN',
        permissions,
        createdAt: '',
      },
    },
  ];
}

function client(options: { totalPages?: number } = {}) {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [IMPORTED],
    page: 1,
    pageSize: 8,
    total: 1,
    totalPages: options.totalPages ?? 1,
  });
  vi.spyOn(api, 'getAllSavedTestPlans').mockResolvedValue([IMPORTED]);
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([SUITE]);
  vi.spyOn(api, 'getAzureDevOpsProjectMembers').mockResolvedValue({
    configured: false,
    organization: null,
    project: null,
    members: [],
  });
  vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue([]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([]);
  vi.spyOn(api, 'getAuditHistory').mockResolvedValue({
    items: [],
    page: 1,
    total: 0,
    totalPages: 0,
  });
  vi.spyOn(api, 'getTestManagementProviders').mockResolvedValue([]);
  // Like the API, the stored metadata of each case is kept when the client sends only its id.
  vi.spyOn(api, 'updateSavedTestPlan').mockImplementation((_id, input) =>
    Promise.resolve({
      ...IMPORTED,
      ...input,
      plans: (input.plans ?? []).map((testCase, index) => ({
        ...testCase,
        metadata: { ...IMPORTED.plans[index]?.metadata, ...testCase.metadata },
      })),
    } as SavedTestPlanDto),
  );
  return api;
}

function view(api: ApiClient, props: Partial<Parameters<typeof TestPlansView>[0]> = {}) {
  return render(
    <TestPlansView
      apiClient={api}
      initialTab="saved"
      activeWorkspaceId="ws-1"
      workspaces={workspaces()}
      {...props}
    />,
  );
}

async function openCaseFromTree(ui: ReturnType<typeof render>) {
  fireEvent.click(await ui.findByRole('button', { name: 'Sprint 10' }));
  fireEvent.click(ui.getByRole('button', { name: 'Mostrar casos de Login' }));
  fireEvent.click(ui.getByRole('button', { name: 'Abrir caso Valid login' }));
  return ui.getByTestId('test-case-modal');
}

beforeEach(() => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => vi.restoreAllMocks());

describe('Test Plans imported from a test management platform', () => {
  it('marks imported Test Plans and opens each case in its own window', async () => {
    const api = client();
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Sprint 10' }));
    expect(ui.getByTitle('Importado de Azure Test Plans')).toBeInTheDocument();
    fireEvent.click(ui.getByRole('button', { name: 'Mostrar casos de Login' }));
    expect(ui.getByTestId('tree-case-plan-1-0')).toHaveTextContent('CT-01Valid login1 passos');
    fireEvent.click(ui.getByRole('button', { name: 'Abrir caso Valid login' }));
    const window = ui.getByTestId('test-case-modal');
    expect(window).toHaveTextContent('Azure Test Plans #50605');
    expect(within(window).getByText('Risk').nextSibling).toHaveTextContent('High');

    fireEvent.change(ui.getByTestId('input-edit-test-title'), { target: { value: 'Login OK' } });
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));
    // The case is saved at once; only its id goes back, the server keeps the rest.
    await waitFor(() =>
      expect(api.updateSavedTestPlan).toHaveBeenCalledWith('plan-1', {
        title: 'Login',
        suiteId: 'suite-1',
        plans: [
          {
            title: 'Login OK',
            description: '<p>Sign in with a valid account</p>',
            steps: [{ order: 1, action: 'Sign in', expectedResult: 'Home shown' }],
            metadata: { caseId: 'case-1' },
          },
        ],
      }),
    );
    expect(ui.queryByTestId('test-case-modal')).toBeNull();
    expect(ui.getByTestId('test-case-CT-01')).toHaveTextContent('Login OK');
    expect(ui.getByTestId('test-case-CT-01')).toHaveTextContent('Azure Test Plans #50605');
  });

  it('automates a suite, a Test Plan or a single case with E2E', async () => {
    const onAutomate = vi.fn();
    const ui = view(client(), { onAutomate });
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Sprint 10' }));
    fireEvent.click(ui.getByRole('button', { name: 'Automatizar com E2E' }));
    expect(onAutomate).toHaveBeenLastCalledWith({ suiteId: 'suite-1' });

    fireEvent.click(ui.getByRole('button', { name: 'Sprint 10' }));
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Login' }));
    fireEvent.click(ui.getByRole('button', { name: 'Automatizar com E2E' }));
    expect(onAutomate).toHaveBeenLastCalledWith({ planId: 'plan-1' });

    fireEvent.click(ui.getByRole('button', { name: 'Mostrar casos de Login' }));
    fireEvent.click(ui.getByRole('button', { name: 'Abrir caso Valid login' }));
    fireEvent.click(
      within(ui.getByTestId('test-case-modal')).getByRole('button', {
        name: 'Automatizar com E2E',
      }),
    );
    expect(onAutomate).toHaveBeenLastCalledWith({ planId: 'plan-1', caseIds: ['case-1'] });
  });

  it('imports from the tree header and reloads suites and plans', async () => {
    const api = client();
    const onOpenIntegrations = vi.fn();
    const ui = view(api, { onOpenIntegrations });
    fireEvent.click(await ui.findByTestId('btn-import-from-provider'));
    expect(await ui.findByTestId('import-test-cases-modal')).toBeInTheDocument();
    fireEvent.click(await ui.findByRole('button', { name: 'Configurar integrações' }));
    expect(onOpenIntegrations).toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: 'Cancelar' }));
    expect(ui.queryByTestId('import-test-cases-modal')).toBeNull();

    // From a suite's menu the import may go into that suite.
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Sprint 10' }));
    fireEvent.click(ui.getByRole('button', { name: 'Importar casos de teste' }));
    vi.mocked(api.getTestManagementProviders).mockClear();
    expect(await ui.findByTestId('import-test-cases-modal')).toBeInTheDocument();
  });

  it('loads every Test Plan for the tree when they span several pages', async () => {
    const api = client({ totalPages: 3 });
    const ui = view(api);
    await waitFor(() => expect(api.getAllSavedTestPlans).toHaveBeenCalled());
    fireEvent.click(await ui.findByRole('button', { name: 'Sprint 10' }));
    expect(ui.getByTestId('saved-plan-card-plan-1')).toBeInTheDocument();
  });

  it('falls back to the current page when every Test Plan cannot be read', async () => {
    const api = client({ totalPages: 2 });
    vi.mocked(api.getAllSavedTestPlans).mockRejectedValue(new Error('offline'));
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Sprint 10' }));
    expect(await ui.findByTestId('saved-plan-card-plan-1')).toBeInTheDocument();
  });

  it('only shows cases to members who can view test plans', async () => {
    const ui = view(client(), {
      isReadOnly: true,
      workspaces: workspaces({ testplans: 'view' }, 'MEMBER'),
    });
    const window = await openCaseFromTree(ui);
    expect(within(window).queryByTestId('btn-save-test-case-modal')).toBeNull();
    expect(ui.queryByTestId('btn-import-from-provider')).toBeNull();
    expect(within(window).queryByRole('button', { name: 'Automatizar com E2E' })).toBeNull();
  });
});
