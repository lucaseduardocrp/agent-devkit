import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Wires the endpoints the saved-plans tab touches, with the page and suites the test needs. */
function client(
  options: {
    plans?: readonly SavedTestPlanDto[];
    suites?: readonly TestSuiteDto[];
    total?: number;
    totalPages?: number;
  } = {},
) {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [...(options.plans ?? [])],
    page: 1,
    pageSize: 8,
    total: options.total ?? options.plans?.length ?? 0,
    totalPages: options.totalPages ?? 1,
  });
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([...(options.suites ?? [])]);
  vi.spyOn(api, 'getTestSuiteProviders').mockResolvedValue([
    { id: 'azure_devops', name: 'Azure DevOps', configured: true },
  ]);
  vi.spyOn(api, 'getRemoteTestPlans').mockResolvedValue([{ id: '7', name: 'Regression plan' }]);
  vi.spyOn(api, 'getRemoteTestSuites').mockResolvedValue([
    { id: '8', name: 'Root', suiteType: 'staticTestSuite' },
    { id: '9', name: 'Existing', parentId: '8', suiteType: 'requirementTestSuite' },
    { id: '10', name: 'Query', parentId: '8', suiteType: 'dynamicTestSuite' },
  ]);
  vi.spyOn(api, 'getAzureDevOpsProjectMembers').mockResolvedValue({
    configured: false,
    organization: null,
    project: null,
    members: [],
  });
  vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue([]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([]);
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

let anchorClick: ReturnType<typeof vi.spyOn>;
let createUrl: ReturnType<typeof vi.fn>;
let revokeUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createUrl = vi.fn(() => 'blob:export');
  revokeUrl = vi.fn();
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    }),
  );
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TestPlansView tab navigation', () => {
  it('moves between the saved and create tabs from the header and the tabs', async () => {
    const api = client({ plans: [plan()] });
    const ui = view(api);

    await waitFor(() => expect(ui.getByTestId('panel-saved-plans')).toBeInTheDocument());

    fireEvent.click(ui.getByTestId('btn-new-test-plan'));
    expect(ui.getByTestId('panel-create-plan')).toBeInTheDocument();

    fireEvent.click(ui.getByTestId('btn-view-saved-plans'));
    expect(ui.getByTestId('panel-saved-plans')).toBeInTheDocument();

    fireEvent.click(ui.getByTestId('tab-create-test-plan'));
    expect(ui.getByTestId('panel-create-plan')).toBeInTheDocument();

    fireEvent.click(ui.getByTestId('tab-saved-test-plans'));
    expect(ui.getByTestId('panel-saved-plans')).toBeInTheDocument();
  });

  it('retries loading the saved plans after a failure', async () => {
    const api = client();
    const load = vi
      .spyOn(api, 'getSavedTestPlans')
      .mockRejectedValueOnce(new Error('The list could not be loaded.'))
      .mockResolvedValue({ items: [plan()], page: 1, pageSize: 8, total: 1, totalPages: 1 });
    const ui = view(api);

    expect(await ui.findByText('The list could not be loaded.')).toBeInTheDocument();
    fireEvent.click(ui.getByRole('button', { name: 'Tentar novamente' }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await ui.findByTestId('saved-plan-card-plan-1')).toBeInTheDocument();
  });

  it('pages through the saved plans', async () => {
    const api = client({ plans: [plan()], total: 20, totalPages: 3 });
    const ui = view(api);

    await ui.findByTestId('saved-plan-card-plan-1');
    const previous = ui.getByRole('button', { name: 'Página anterior' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);

    fireEvent.click(ui.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(api.getSavedTestPlans).toHaveBeenCalledWith(2, 8));

    fireEvent.click(ui.getByRole('button', { name: 'Página anterior' }));
    await waitFor(() => expect(api.getSavedTestPlans).toHaveBeenCalledWith(1, 8));
  });
});

describe('TestPlansView suite management', () => {
  it('publishes a suite and links to the remote result', async () => {
    const api = client({ suites: [suite()], plans: [plan({ suiteId: 'suite-1' })] });
    const push = vi.spyOn(api, 'pushTestSuite').mockResolvedValue({
      provider: 'azure_devops',
      remotePlanId: '7',
      remoteSuiteId: '8',
      remoteUrl: 'https://dev.azure.com/org/QA/_testPlans/define?planId=7&suiteId=8',
      suitesCount: 1,
      casesCount: 1,
    });
    const ui = view(api);
    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Publicar suite' }));
    expect(push).not.toHaveBeenCalled();
    const dialog = ui.getByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('suite-1', {
        providerId: 'azure_devops',
        suiteKind: 'static',
      }),
    );
    expect(await ui.findByRole('link', { name: 'Abrir no Test Plans' })).toHaveAttribute(
      'href',
      'https://dev.azure.com/org/QA/_testPlans/define?planId=7&suiteId=8',
    );
  });

  it('adds cases to a selected requirement suite and marks query suites read only', async () => {
    const api = client({ suites: [suite()], plans: [plan({ suiteId: 'suite-1' })] });
    const push = vi.spyOn(api, 'pushTestSuite').mockResolvedValue({
      provider: 'azure_devops',
      remotePlanId: '7',
      remoteSuiteId: '10',
      remoteUrl: 'https://dev.azure.com/org/QA/_testPlans/define?planId=7&suiteId=10',
      suitesCount: 1,
      casesCount: 1,
    });
    const ui = view(api);
    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Publicar suite' }));
    const dialog = ui.getByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    const parent = await within(dialog).findByLabelText('Suite de destino');
    await waitFor(() =>
      expect(within(parent).getByRole('option', { name: /Root \/ Existing/ })).toBeInTheDocument(),
    );
    expect(
      (within(parent).getByRole('option', { name: /Root \/ Existing/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(parent).getByRole('option', { name: /Query.*somente leitura/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(parent, { target: { value: '9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('suite-1', {
        providerId: 'azure_devops',
        remotePlanId: '7',
        remoteSuiteId: '9',
      }),
    );
  });

  it('creates a named suite inside the selected remote suite', async () => {
    const api = client({ suites: [suite()], plans: [plan({ suiteId: 'suite-1' })] });
    const push = vi.spyOn(api, 'pushTestSuite').mockResolvedValue({
      provider: 'azure_devops',
      remotePlanId: '7',
      remoteSuiteId: '11',
      remoteUrl: 'https://example.com',
      suitesCount: 1,
      casesCount: 1,
    });
    const ui = view(api);
    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Publicar suite' }));
    const dialog = ui.getByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    const parent = await within(dialog).findByLabelText('Suite de destino');
    await waitFor(() =>
      expect(within(parent).getByRole('option', { name: /Root \/ Existing/ })).toBeInTheDocument(),
    );
    fireEvent.change(parent, { target: { value: '9' } });
    const placement = within(dialog).getByLabelText('Onde adicionar os casos');
    expect(
      (within(placement).getByRole('option', { name: /Em uma nova suite/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(parent, { target: { value: '8' } });
    expect(
      (within(placement).getByRole('option', { name: /Em uma nova suite/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
    fireEvent.change(placement, { target: { value: 'child' } });
    const name = within(dialog).getByLabelText('Nome da nova suite');
    fireEvent.change(name, { target: { value: '   ' } });
    expect(
      (within(dialog).getByRole('button', { name: 'Publicar suite' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(name, { target: { value: '  Sprint 181  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('suite-1', {
        providerId: 'azure_devops',
        remotePlanId: '7',
        remoteParentSuiteId: '8',
        remoteSuiteName: 'Sprint 181',
        suiteKind: 'static',
      }),
    );
  });

  it('shows a provider error when publishing fails', async () => {
    const api = client({ suites: [suite()] });
    vi.spyOn(api, 'pushTestSuite').mockRejectedValue(new Error('Azure rejected the token.'));
    const ui = view(api);
    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Publicar suite' }));
    const dialog = ui.getByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Azure rejected the token.');
  });

  it('creates a suite through the tree and reloads them', async () => {
    const api = client({ suites: [suite()] });
    const create = vi.spyOn(api, 'createTestSuite').mockResolvedValue(suite({ id: 'suite-2' }));
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.click(
      within(ui.getByTestId('test-suite-tree')).getByRole('button', { name: 'Nova Test Suite' }),
    );
    fireEvent.change(within(ui.getByTestId('test-suite-tree')).getByRole('textbox'), {
      target: { value: 'Smoke' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('Smoke', undefined));
    await waitFor(() => expect(api.getTestSuites).toHaveBeenCalledTimes(2));
  });

  it('reports a failure to create a suite', async () => {
    const api = client({ suites: [suite()] });
    vi.spyOn(api, 'createTestSuite').mockRejectedValue(new Error('The suite already exists.'));
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.click(
      within(ui.getByTestId('test-suite-tree')).getByRole('button', { name: 'Nova Test Suite' }),
    );
    fireEvent.change(within(ui.getByTestId('test-suite-tree')).getByRole('textbox'), {
      target: { value: 'Smoke' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Confirmar' }));

    expect(await ui.findByText('The suite already exists.')).toBeInTheDocument();
  });

  it('renames a suite through the tree', async () => {
    const api = client({ suites: [suite()] });
    const rename = vi.spyOn(api, 'updateTestSuite').mockResolvedValue(suite({ name: 'Smoke' }));
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(ui.getByTestId('test-suite-tree')).getByRole('textbox'), {
      target: { value: 'Smoke' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('suite-1', { name: 'Smoke' }));
  });

  it('requires typing the suite name before confirming its deletion, then cascades', async () => {
    const api = client({ suites: [suite()] });
    const remove = vi.spyOn(api, 'deleteTestSuite').mockResolvedValue();
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));

    const confirmButton = ui.getByTestId('confirm-delete-suite-btn') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    fireEvent.change(ui.getByTestId('delete-suite-confirm-input'), {
      target: { value: 'Regression' },
    });
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(remove).toHaveBeenCalledWith('suite-1'));
  });

  it('reports a suite that cannot be deleted', async () => {
    const api = client({ suites: [suite()] });
    vi.spyOn(api, 'deleteTestSuite').mockRejectedValue(new Error('The suite is not empty.'));
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));
    fireEvent.change(ui.getByTestId('delete-suite-confirm-input'), {
      target: { value: 'Regression' },
    });
    fireEvent.click(ui.getByTestId('confirm-delete-suite-btn'));

    expect(await ui.findByText('The suite is not empty.')).toBeInTheDocument();
  });
});

describe('TestPlansView suite export', () => {
  it('downloads a zip containing every plan in the suite and its descendants', async () => {
    const api = client({
      suites: [suite(), suite({ id: 'suite-child', name: 'Card', parentId: 'suite-1' })],
      plans: [plan({ suiteId: 'suite-1' }), plan({ id: 'plan-2', suiteId: 'suite-child' })],
    });
    vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
      items: [plan({ suiteId: 'suite-1' }), plan({ id: 'plan-2', suiteId: 'suite-child' })],
      page: 1,
      pageSize: 50,
      total: 2,
      totalPages: 1,
    });
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'standard' } });
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar suite (.zip)' }));

    await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
    expect(createUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith('blob:export');
  });

  it('collects the plans across every page of the workspace', async () => {
    const api = client({ suites: [suite()] });
    const load = vi
      .spyOn(api, 'getSavedTestPlans')
      .mockResolvedValueOnce({ items: [], page: 1, pageSize: 8, total: 0, totalPages: 1 })
      .mockResolvedValueOnce({
        items: [plan({ suiteId: 'suite-1' })],
        page: 1,
        pageSize: 50,
        total: 2,
        totalPages: 2,
      })
      .mockResolvedValue({
        items: [plan({ id: 'plan-2', suiteId: 'suite-1' })],
        page: 2,
        pageSize: 50,
        total: 2,
        totalPages: 2,
      });
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'standard' } });
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar suite (.zip)' }));

    await waitFor(() => expect(load).toHaveBeenCalledWith(2, 50));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
  });

  it('reports an export of a suite that holds no plan', async () => {
    const api = client({ suites: [suite()] });
    const ui = view(api);

    await ui.findByTestId('test-suite-tree');
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'standard' } });
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar suite (.zip)' }));

    expect(await ui.findByRole('alert')).toHaveTextContent('pelo menos um passo');
    expect(anchorClick).not.toHaveBeenCalled();
  });
});

describe('TestPlansView case editing', () => {
  async function opened() {
    const api = client({ plans: [plan()] });
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    return ui;
  }

  it('adds a case and opens it for editing', async () => {
    const ui = await opened();

    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-add-test-case'));

    expect(ui.getByTestId('test-case-CT-02')).toBeInTheDocument();
    expect(ui.getByLabelText('Título do caso de teste')).toBeInTheDocument();
  });

  it('deletes a case from the list', async () => {
    const ui = await opened();

    expect(ui.getByTestId('test-case-CT-01')).toBeInTheDocument();
    fireEvent.click(ui.getByTestId('btn-delete-test-CT-01'));

    expect(ui.queryByTestId('test-case-CT-01')).not.toBeInTheDocument();
  });

  it('opens the delete dialog for the plan being edited', async () => {
    const ui = await opened();

    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-delete-current-plan'));

    expect(ui.getByTestId('confirm-delete-plan-btn')).toBeInTheDocument();
  });
});

describe('TestPlansView export settings', () => {
  it('switches to the standard format and hides the Azure fields', async () => {
    const api = client({ plans: [plan()] });
    const ui = view(api);

    await ui.findByTestId('panel-saved-plans');
    fireEvent.change(ui.getByLabelText('Formato de exportação'), {
      target: { value: 'standard' },
    });

    expect(ui.queryByLabelText('Area Path')).not.toBeInTheDocument();

    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'azure' } });
    await waitFor(() => expect(ui.getByLabelText('Area Path')).toBeInTheDocument());
  });

  it('reloads the Azure options after a failure', async () => {
    const api = client({ plans: [plan()] });
    const load = vi
      .spyOn(api, 'getAzureDevOpsProjectMembers')
      .mockRejectedValue(new Error('offline'));
    const ui = view(api);

    await ui.findByTestId('panel-saved-plans');
    fireEvent.change(ui.getByLabelText('Formato de exportação'), {
      target: { value: 'standard' },
    });
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'azure' } });

    fireEvent.click(await ui.findByRole('button', { name: 'Recarregar opções do Azure' }));
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(1));
  });
});
