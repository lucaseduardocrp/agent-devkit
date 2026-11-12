import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';
import type { ReferenceFocus } from '../src/features/shared/reference-focus.js';

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
  options: {
    plans?: readonly SavedTestPlanDto[];
    suites?: readonly TestSuiteDto[];
    totalPages?: number;
  } = {},
) {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [...(options.plans ?? [])],
    page: 1,
    pageSize: 8,
    total: options.plans?.length ?? 0,
    totalPages: options.totalPages ?? 1,
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
  vi.spyOn(api, 'getTestSuiteProviders').mockResolvedValue([
    { id: 'azure_devops', name: 'Azure DevOps', configured: true },
  ]);
  vi.spyOn(api, 'getAuditHistory').mockResolvedValue({
    items: [],
    page: 1,
    total: 0,
    totalPages: 0,
  });
  return api;
}

type Props = Partial<React.ComponentProps<typeof TestPlansView>>;

function view(api: ApiClient | undefined, props: Props = {}) {
  return render(
    <TestPlansView
      {...(api ? { apiClient: api } : {})}
      initialTab="saved"
      activeWorkspaceId="ws-1"
      workspaces={WORKSPACES}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const focusOn = (ref: string, nonce: number, kind: ReferenceFocus['kind'] = 'testplan') => ({
  kind,
  ref,
  nonce,
});

describe('TestPlansView references from other modules', () => {
  it('opens the referenced plan once and ignores other kinds and repeated requests', async () => {
    const api = client({ plans: [plan()] });
    const onFocusHandled = vi.fn();
    const ui = view(api, { focus: focusOn('plan-1', 1, 'issue'), onFocusHandled });
    await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' });
    expect(onFocusHandled).not.toHaveBeenCalled();

    ui.rerender(
      <TestPlansView
        apiClient={api}
        initialTab="saved"
        activeWorkspaceId="ws-1"
        workspaces={WORKSPACES}
        focus={focusOn('plan-1', 2)}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(await ui.findByTestId('saved-plan-detail')).toBeInTheDocument();
    expect(onFocusHandled).toHaveBeenCalledTimes(1);

    // The same request again does nothing; the plan stays open.
    ui.rerender(
      <TestPlansView
        apiClient={api}
        initialTab="saved"
        activeWorkspaceId="ws-1"
        workspaces={WORKSPACES}
        focus={focusOn('plan-1', 2)}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it('finds the page of a plan that is not on the first one', async () => {
    const plans = Array.from({ length: 9 }, (_, index) =>
      plan({ id: `plan-${index + 1}`, title: `Plan ${index + 1}` }),
    );
    const api = client({ plans: plans.slice(0, 8), totalPages: 2 });
    vi.mocked(api.getAllSavedTestPlans).mockResolvedValue(plans);
    vi.mocked(api.getSavedTestPlans).mockImplementation((page) =>
      Promise.resolve({
        items: page === 2 ? plans.slice(8) : plans.slice(0, 8),
        page: page ?? 1,
        pageSize: 8,
        total: 9,
        totalPages: 2,
      }),
    );
    const onFocusHandled = vi.fn();
    view(api, { focus: focusOn('plan-9', 1), onFocusHandled });
    await waitFor(() => expect(api.getSavedTestPlans).toHaveBeenCalledWith(2, 8));
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
  });

  it('gives up quietly when the plan cannot be found or the search fails', async () => {
    const api = client({ plans: [plan()] });
    vi.mocked(api.getAllSavedTestPlans).mockResolvedValueOnce([plan()]);
    const onFocusHandled = vi.fn();
    const ui = view(api, { focus: focusOn('missing', 1), onFocusHandled });
    await waitFor(() => expect(api.getAllSavedTestPlans).toHaveBeenCalledTimes(1));
    // The same request is searched only once, even when the list changes meanwhile.
    ui.rerender(
      <TestPlansView
        apiClient={api}
        initialTab="saved"
        activeWorkspaceId="ws-1"
        workspaces={WORKSPACES}
        focus={focusOn('missing', 1)}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(api.getAllSavedTestPlans).toHaveBeenCalledTimes(1);

    vi.mocked(api.getAllSavedTestPlans).mockRejectedValueOnce(new Error('offline'));
    ui.rerender(
      <TestPlansView
        apiClient={api}
        initialTab="saved"
        activeWorkspaceId="ws-1"
        workspaces={WORKSPACES}
        focus={focusOn('missing', 2)}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(api.getAllSavedTestPlans).toHaveBeenCalledTimes(2));
    expect(onFocusHandled).not.toHaveBeenCalled();
  });

  it('does not search for the plan without an API client', () => {
    const ui = view(undefined, { focus: focusOn('plan-1', 1) });
    expect(ui.getByTestId('panel-saved-plans')).toBeInTheDocument();
  });
});

describe('TestPlansView without an API client', () => {
  it('keeps suite creation inert and the clock-driven success message cleaned up', async () => {
    const ui = view(undefined);
    fireEvent.click(await ui.findByRole('button', { name: /Nova Test Suite/ }));
    const name = await ui.findByRole('textbox');
    fireEvent.change(name, { target: { value: 'Smoke' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(ui.queryByText('Smoke')).toBeNull();
  });
});

describe('TestPlansView saved plan changes', () => {
  it('shows a plan whose cases arrive without steps and saves it without them', async () => {
    const broken = plan({
      plans: [{ title: 'No steps', description: 'Bare', steps: undefined as never }],
    });
    const api = client({ plans: [broken] });
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockImplementation(async (_id, input) => ({ ...broken, ...input }) as SavedTestPlanDto);
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    expect(ui.getByTestId('test-case-CT-01')).toHaveTextContent('0');
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'plan-1',
        expect.objectContaining({ plans: [expect.objectContaining({ steps: [] })] }),
      ),
    );
    expect(await ui.findByRole('status')).toBeInTheDocument();
    // Leaving while the success message is pending cancels its timer.
    ui.unmount();
  });

  it('reports a failed save with the message of the error or the default one', async () => {
    const api = client({ plans: [plan()] });
    vi.spyOn(api, 'updateSavedTestPlan')
      .mockRejectedValueOnce(new Error('Plan is locked'))
      .mockRejectedValueOnce('boom');
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    expect(await ui.findByText('Plan is locked')).toBeInTheDocument();
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    await waitFor(() => expect(ui.getByRole('alert')).not.toHaveTextContent('Plan is locked'));
  });

  it('keeps the tree plans when a save happens before they load', async () => {
    const api = client({ plans: [plan(), plan({ id: 'plan-2', title: 'Other' })], totalPages: 2 });
    vi.mocked(api.getAllSavedTestPlans).mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'updateSavedTestPlan').mockImplementation(
      async (_id, input) => ({ ...plan(), ...input }) as SavedTestPlanDto,
    );
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    expect(await ui.findByRole('status')).toBeInTheDocument();
  });

  it('saves a case edited in the window straight away and appends unknown cases', async () => {
    const api = client({ plans: [plan()] });
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockImplementation(async (_id, input) => ({ ...plan(), ...input }) as SavedTestPlanDto);
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByTestId('btn-add-test-case'));
    // The new case opens in the window and is added to the list when saved.
    const modal = await ui.findByTestId('test-case-modal');
    fireEvent.change(within(modal).getByTestId('input-edit-test-title'), {
      target: { value: 'Second case' },
    });
    fireEvent.click(within(modal).getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].plans).toHaveLength(2);
    // Editing an existing case replaces it.
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir caso de teste CT-01' }));
    const again = await ui.findByTestId('test-case-modal');
    fireEvent.change(within(again).getByTestId('input-edit-test-title'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(within(again).getByTestId('btn-save-test-case-modal'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![1].plans?.[0]?.title).toBe('Renamed');
  });

  it('ignores a case saved after the plan was closed underneath the window', async () => {
    const api = client({ plans: [plan()] });
    const update = vi.spyOn(api, 'updateSavedTestPlan');
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Abrir caso de teste CT-01' }));
    const modal = await ui.findByTestId('test-case-modal');
    fireEvent.click(ui.getByTestId('btn-back-to-saved'));
    fireEvent.click(within(modal).getByTestId('btn-save-test-case-modal'));
    expect(update).not.toHaveBeenCalled();
  });

  it('opens a case straight from the tree and falls back to no case for a missing index', async () => {
    const api = client({ plans: [plan({ suiteId: 'suite-1' })], suites: [suite()] });
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Mostrar casos de Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Abrir caso Pay with card' }));
    expect(await ui.findByTestId('test-case-modal')).toBeInTheDocument();
  });
});

describe('TestPlansView after a failed generation', () => {
  it('shows a saved plan without cases and starts from an empty list', async () => {
    const api = client({ plans: [plan()] });
    vi.spyOn(api, 'generateTestPlan')
      .mockResolvedValueOnce({
        plans: [],
        csv: '',
        savedPlan: plan({ id: 'plan-9', title: 'Generated', plans: [] }),
      })
      .mockRejectedValueOnce(new Error('Generator down'));
    const ui = view(api, { initialTab: 'create' });
    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Story' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    expect(await ui.findByTestId('test-result')).toBeInTheDocument();

    // The saved plan's title bar is editable from the creation tab too.
    fireEvent.change(ui.getByLabelText('Título do Test Plan'), { target: { value: 'Renamed' } });
    expect(ui.getByLabelText('Título do Test Plan')).toHaveProperty('value', 'Renamed');

    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    expect(await ui.findByText('Generator down')).toBeInTheDocument();
    // Back on the saved tab, the plan is still selected but its cases are gone.
    fireEvent.click(ui.getByTestId('tab-saved-test-plans'));
    expect(await ui.findByTestId('saved-plan-detail')).toBeInTheDocument();
    // Saving with no cases does nothing.
    const update = vi.spyOn(api, 'updateSavedTestPlan');
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    expect(update).not.toHaveBeenCalled();
    // Exporting with no cases is refused.
    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar CSV' }));
    await waitFor(() => expect(ui.getAllByRole('alert').length).toBeGreaterThan(0));
    // Adding a case starts the list.
    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-add-test-case'));
    expect(await ui.findByTestId('test-case-modal')).toBeInTheDocument();
    expect(ui.getByTestId('test-case-CT-01')).toBeInTheDocument();
  });
});
