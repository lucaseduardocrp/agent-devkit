import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { exportFormatSelect } from './helpers/export-format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';

const ISO = '2026-09-18T00:00:00.000Z';
const LOAD_FAILED = 'Falha ao carregar Test Plans.';
const CSV_FAILED = 'Não foi possível baixar o CSV no momento.';

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
  vi.spyOn(api, 'getTestSuiteProviders').mockResolvedValue([
    { id: 'azure_devops', name: 'Azure DevOps', configured: true },
  ]);
  vi.spyOn(api, 'getRemoteTestPlans').mockResolvedValue([]);
  vi.spyOn(api, 'getRemoteTestSuites').mockResolvedValue([]);
  return api;
}

function view(api: ApiClient | undefined) {
  return render(
    <TestPlansView
      {...(api ? { apiClient: api } : {})}
      initialTab="saved"
      activeWorkspaceId="ws-1"
      workspaces={WORKSPACES}
    />,
  );
}

let createUrl: ReturnType<typeof vi.fn>;
let anchorClick: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createUrl = vi.fn(() => 'blob:export');
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: createUrl,
      revokeObjectURL: vi.fn(),
    }),
  );
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openTree(api: ApiClient) {
  const ui = view(api);
  await ui.findByTestId('test-suite-tree');
  return ui;
}

describe('TestPlansView suite failures', () => {
  it('reports suite creation, rename and deletion failures that carry no message', async () => {
    const api = client({ suites: [suite()] });
    vi.spyOn(api, 'createTestSuite').mockRejectedValue('nope');
    vi.spyOn(api, 'updateTestSuite')
      .mockRejectedValueOnce(new Error('Name taken'))
      .mockRejectedValue('nope');
    vi.spyOn(api, 'deleteTestSuite').mockRejectedValue('nope');
    const ui = await openTree(api);
    const tree = ui.getByTestId('test-suite-tree');

    fireEvent.click(within(tree).getByRole('button', { name: 'Nova Test Suite' }));
    fireEvent.change(within(tree).getByRole('textbox'), { target: { value: 'Smoke' } });
    fireEvent.click(ui.getByRole('button', { name: 'Confirmar' }));
    expect(await ui.findByText(LOAD_FAILED)).toBeTruthy();

    for (const message of ['Name taken', LOAD_FAILED]) {
      fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
      fireEvent.click(ui.getByRole('button', { name: 'Editar' }));
      fireEvent.change(within(tree).getByRole('textbox'), { target: { value: 'Other' } });
      fireEvent.click(ui.getByRole('button', { name: 'Confirmar' }));
      await waitFor(() => expect(ui.getByRole('alert')).toHaveTextContent(message));
    }

    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));
    fireEvent.change(ui.getByTestId('delete-suite-confirm-input'), {
      target: { value: 'Regression' },
    });
    fireEvent.click(ui.getByTestId('confirm-delete-suite-btn'));
    expect(await within(ui.getByRole('dialog')).findByText(LOAD_FAILED)).toBeTruthy();
  });

  it('ignores a suite deletion confirmed after the API client is gone', async () => {
    const api = client({ suites: [suite()] });
    const remove = vi.spyOn(api, 'deleteTestSuite');
    const ui = await openTree(api);
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));
    fireEvent.change(ui.getByTestId('delete-suite-confirm-input'), {
      target: { value: 'Regression' },
    });
    ui.rerender(
      <TestPlansView initialTab="saved" activeWorkspaceId="ws-1" workspaces={WORKSPACES} />,
    );
    fireEvent.click(ui.getByTestId('confirm-delete-suite-btn'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the agents list empty when loading them fails', async () => {
    const api = client();
    vi.mocked(api.getAgents).mockRejectedValue(new Error('offline'));
    const ui = view(api);
    await waitFor(() => expect(api.getAgents).toHaveBeenCalled());
    expect(ui.getByTestId('tab-create-test-plan')).toBeInTheDocument();
  });

  it('describes the work items linked when publishing a suite', async () => {
    const api = client({ suites: [suite()], plans: [plan({ suiteId: 'suite-1' })] });
    const result = {
      provider: 'azure_devops',
      remotePlanId: '7',
      remoteSuiteId: '8',
      remoteUrl: 'https://dev.azure.com/org/QA',
      suitesCount: 1,
      casesCount: 1,
    };
    const push = vi
      .spyOn(api, 'pushTestSuite')
      .mockResolvedValueOnce({
        ...result,
        workItems: [{ type: 'Requirement', id: '50059' }],
      } as never)
      .mockResolvedValueOnce({
        ...result,
        workItems: [
          { type: 'Requirement', id: '1' },
          { type: 'Requirement', id: '2' },
        ],
      } as never);
    const ui = await openTree(api);
    for (const expected of [/50059/, /2/]) {
      fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
      fireEvent.click(ui.getByRole('button', { name: 'Publicar suite' }));
      const dialog = ui.getByRole('dialog');
      fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
        target: { value: 'azure_devops' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
      await waitFor(() => expect(ui.getByRole('status')).toHaveTextContent(expected));
      await waitFor(() => expect(ui.queryByRole('dialog')).toBeNull());
    }
    expect(push).toHaveBeenCalledTimes(2);
  });
});

describe('TestPlansView plan deletion', () => {
  it('steps back a page when the last plan of the page is deleted', async () => {
    const plans = Array.from({ length: 9 }, (_, index) =>
      plan({ id: `plan-${index + 1}`, title: `Plan ${index + 1}` }),
    );
    const api = client({ plans });
    vi.mocked(api.getSavedTestPlans).mockImplementation((page) =>
      Promise.resolve({
        items: page === 2 ? plans.slice(8) : plans.slice(0, 8),
        page: page ?? 1,
        pageSize: 8,
        total: 9,
        totalPages: 2,
      }),
    );
    const remove = vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    const ui = view(api);
    await ui.findByRole('button', { name: 'Abrir Test Plan Plan 1' });
    fireEvent.click(ui.getByRole('button', { name: 'Próxima página' }));
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Plan 9' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Plan 9' }));
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('plan-9'));
    await waitFor(() => expect(api.getSavedTestPlans).toHaveBeenLastCalledWith(1, 8));
  });

  it('closes the plan being edited when it is deleted', async () => {
    const api = client({ plans: [plan()] });
    vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-delete-current-plan'));
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));
    await waitFor(() => expect(ui.queryByTestId('saved-plan-detail')).toBeNull());
  });
});

describe('TestPlansView exports that fail', () => {
  it('exports the cases of a plan whose steps are missing as an incomplete case', async () => {
    const broken = plan({
      plans: [{ title: 'No steps', description: 'Bare', steps: undefined as never }],
    });
    const ui = view(client({ plans: [broken] }));
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar CSV' }));
    expect(await ui.findByRole('alert')).toBeInTheDocument();
  });

  it('reports the message of an unexpected failure while downloading a plan', async () => {
    const ui = view(client({ plans: [plan()] }));
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    createUrl.mockImplementationOnce(() => {
      throw new Error('Blob unsupported');
    });
    createUrl.mockImplementationOnce(() => {
      throw 'Blob unsupported';
    });
    fireEvent.change(exportFormatSelect(ui), { target: { value: 'standard' } });
    for (const expected of ['Blob unsupported', CSV_FAILED]) {
      fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
      fireEvent.click(ui.getByRole('button', { name: 'Exportar CSV' }));
      await waitFor(() => expect(ui.getByRole('alert')).toHaveTextContent(expected));
    }
  });

  it('names suite files after plans with blank titles and reports unexpected failures', async () => {
    const api = client({
      suites: [suite()],
      plans: [plan({ title: '   ', suiteId: 'suite-1' })],
    });
    const ui = await openTree(api);
    fireEvent.change(exportFormatSelect(ui), { target: { value: 'standard' } });
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar suite (.zip)' }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());

    vi.mocked(api.getSavedTestPlans).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(ui.getByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar suite (.zip)' }));
    expect(await ui.findByRole('alert')).toHaveTextContent(CSV_FAILED);
  });
});
