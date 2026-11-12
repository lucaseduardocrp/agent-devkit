import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';

const ISO = '2026-09-18T00:00:00.000Z';

function suite(overrides: Partial<TestSuiteDto> = {}): TestSuiteDto {
  return {
    id: 'suite-1',
    workspaceId: 'ws-1',
    name: 'Regression',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function plan(overrides: Partial<SavedTestPlanDto> = {}): SavedTestPlanDto {
  return {
    id: 'plan-1',
    workspaceId: 'ws-1',
    title: 'Checkout',
    plans: [
      {
        title: 'Pay with card',
        description: 'Complete the payment',
        steps: [{ order: 1, action: 'Open the cart', expectedResult: 'The cart is visible' }],
      },
    ],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

const WORKSPACES = [
  {
    workspace: { id: 'ws-1', name: 'Workspace', slug: 'ws', ownerId: 'u1', createdAt: '' },
    member: {
      id: 'm1',
      workspaceId: 'ws-1',
      userId: 'u1',
      role: 'ADMIN' as const,
      permissions: {},
      createdAt: '',
    },
  },
];

function client(
  options: { plans?: readonly SavedTestPlanDto[]; suites?: readonly TestSuiteDto[] } = {},
) {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [...(options.plans ?? [])],
    page: 1,
    pageSize: 8,
    total: options.plans?.length ?? 0,
    totalPages: 1,
  });
  vi.spyOn(api, 'getAllSavedTestPlans').mockResolvedValue([...(options.plans ?? [])]);
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([...(options.suites ?? [])]);
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
  return api;
}

function view(api: ApiClient, initialTab: 'saved' | 'create' = 'saved') {
  return render(
    <TestPlansView
      apiClient={api}
      initialTab={initialTab}
      activeWorkspaceId="ws-1"
      workspaces={WORKSPACES}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TestPlansView flows through the suite tree', () => {
  it('opens the creation tab from the create plan action of a suite', async () => {
    const ui = view(client({ suites: [suite()] }));
    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Criar Test Plan' }));
    expect(await ui.findByLabelText('Test suite')).toBeInTheDocument();
    expect(ui.getByTestId('tab-create-test-plan')).toBeInTheDocument();
  });

  it('reloads suites and plans after importing from a provider', async () => {
    const api = client({ suites: [suite()] });
    vi.spyOn(api, 'getTestManagementProviders').mockResolvedValue([
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
    ]);
    vi.spyOn(api, 'getTestManagementPlans').mockResolvedValue([{ id: '10', name: 'Sprint 10' }]);
    vi.spyOn(api, 'importTestCases').mockResolvedValue({
      rootSuiteId: 'local-root',
      suitesCreated: 1,
      plans: [],
      created: 1,
      updated: 0,
    });
    const ui = view(api);
    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByTestId('btn-import-from-provider'));
    await waitFor(() =>
      expect(ui.getByLabelText('Test Plan').querySelectorAll('option')).toHaveLength(2),
    );
    fireEvent.change(ui.getByLabelText('Test Plan'), { target: { value: '10' } });
    fireEvent.click(ui.getByTestId('btn-import-test-cases'));
    fireEvent.click(await ui.findByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(api.getTestSuites).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ui.queryByTestId('import-test-cases-result')).toBeNull());
  });
});

describe('TestPlansView creation tab with a saved plan', () => {
  it('lets the suite of a generated plan be changed and saved from the result', async () => {
    const api = client({ suites: [suite(), suite({ id: 'suite-2', name: 'Smoke' })] });
    const saved = plan({ id: 'plan-9', title: 'Generated', suiteId: 'suite-1' });
    vi.spyOn(api, 'generateTestPlan').mockResolvedValue({
      plans: saved.plans,
      csv: '',
      savedPlan: saved,
    });
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockImplementation(async (_id, input) => ({ ...saved, ...input }) as SavedTestPlanDto);
    const ui = view(api, 'create');
    await waitFor(() => expect(api.getTestSuites).toHaveBeenCalled());
    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Story' } });
    fireEvent.change(await ui.findByLabelText('Test suite'), { target: { value: 'suite-1' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    const result = await ui.findByTestId('test-result');
    fireEvent.change(within(result).getByLabelText('Test Plans salvos'), {
      target: { value: 'suite-2' },
    });
    fireEvent.click(within(result).getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'plan-9',
        expect.objectContaining({ suiteId: 'suite-2' }),
      ),
    );
  });
});

describe('TestPlansView dialogs', () => {
  it('closes the delete dialogs with Escape and the suite one with Cancel', async () => {
    const api = client({ suites: [suite()], plans: [plan()] });
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-delete-current-plan'));
    expect(ui.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(ui.queryByRole('dialog')).toBeNull());
    fireEvent.click(ui.getByTestId('btn-back-to-saved'));

    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));
    expect(ui.getByTestId('delete-suite-confirm-input')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(ui.queryByRole('dialog')).toBeNull());

    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(within(ui.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(ui.queryByRole('dialog')).toBeNull());
  });

  it('appends a case saved after it was deleted underneath its window', async () => {
    const api = client({ plans: [plan()] });
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockImplementation(async (_id, input) => ({ ...plan(), ...input }) as SavedTestPlanDto);
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Abrir caso de teste CT-01' }));
    const modal = await ui.findByTestId('test-case-modal');
    fireEvent.click(ui.getByTestId('btn-delete-test-CT-01'));
    fireEvent.click(within(modal).getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].plans).toHaveLength(1);
  });
});

describe('TestPlansView remaining actions', () => {
  it('opens a plan from its edit button, deletes a case and closes the publish dialog', async () => {
    const api = client({
      suites: [suite()],
      plans: [plan({ suiteId: 'suite-1' }), plan({ id: 'plan-2', title: 'Loose' })],
    });
    vi.spyOn(api, 'getTestSuiteProviders').mockResolvedValue([]);
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Loose' }));
    fireEvent.click(ui.getByRole('button', { name: 'Editar Loose' }));
    fireEvent.click(await ui.findByTestId('btn-delete-test-CT-01'));
    expect(ui.queryByTestId('test-case-CT-01')).toBeNull();
    fireEvent.click(ui.getByTestId('btn-back-to-saved'));
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Publicar suite' }));
    fireEvent.click(within(ui.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(ui.queryByRole('dialog')).toBeNull());
  });
});

describe('TestPlansView generated list', () => {
  it('deletes a case from the generated result of the creation tab', async () => {
    const api = client();
    vi.spyOn(api, 'generateTestPlan').mockResolvedValue({
      plans: plan().plans,
      csv: '',
      savedPlan: plan(),
    });
    const ui = view(api, 'create');
    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Story' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    fireEvent.click(await ui.findByTestId('btn-delete-test-CT-01'));
    expect(ui.queryByTestId('btn-delete-test-CT-01')).toBeNull();
  });
});
