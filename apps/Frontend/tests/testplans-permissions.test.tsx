import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { TestSuiteTree } from '../src/features/testplans/TestSuiteTree.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type { ModuleAccess } from '../src/features/workspaces/workspace-types.js';
import { ApiClient, type SavedTestPlanDto } from '../src/lib/api-client.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

const ISO = '2026-10-07T00:00:00.000Z';
const step = { order: 1, action: 'Open', expectedResult: 'Opened' };
const savedPlan: SavedTestPlanDto = {
  id: 'plan-1',
  workspaceId: 'ws-1',
  title: 'Checkout',
  plans: [
    { title: 'Pay', description: 'Pay by card', steps: [step], metadata: { caseId: 'case-a' } },
    { title: 'Legacy', description: 'No id yet', steps: [step] },
  ],
  createdAt: ISO,
  updatedAt: ISO,
};

function client() {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [savedPlan],
    page: 1,
    pageSize: 8,
    total: 1,
    totalPages: 1,
  });
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([]);
  vi.spyOn(api, 'getAgents').mockResolvedValue([]);
  vi.spyOn(api, 'getAuditHistory').mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    totalPages: 0,
  });
  return api;
}

function renderView(api: ApiClient, testplans: ModuleAccess, isReadOnly = false) {
  return render(
    <PermissionsProvider
      access={{ ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, testplans } }}
    >
      <TestPlansView
        apiClient={api}
        activeWorkspaceId="ws-1"
        initialTab="saved"
        isReadOnly={isReadOnly}
      />
    </PermissionsProvider>,
  );
}

async function openPlan(view: ReturnType<typeof render>) {
  fireEvent.click(await view.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
  return view.findByTestId('saved-plan-detail');
}

describe('Test plan permissions and per-case history', () => {
  it('shows the history of each saved case and keeps case IDs when saving', async () => {
    const api = client();
    const update = vi.spyOn(api, 'updateSavedTestPlan').mockResolvedValue({
      ...savedPlan,
      plans: [
        savedPlan.plans[0]!,
        { ...savedPlan.plans[1]!, metadata: { caseId: 'case-b', formattedDescription: 'x' } },
      ],
    });
    const view = renderView(api, 'delete');
    await openPlan(view);

    const first = view.getByTestId('test-case-CT-01');
    const legacy = view.getByTestId('test-case-CT-02');
    // Cases saved before IDs existed get one on the next save.
    expect(within(legacy).queryByRole('button', { name: 'Histórico' })).not.toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(api.getAuditHistory).toHaveBeenCalledWith(
        'testcase',
        1,
        expect.any(AbortSignal),
        'plan-1:case-a',
      ),
    );
    expect(within(first).getByTestId('btn-delete-test-CT-01')).toBeInTheDocument();

    fireEvent.click(view.getByTestId('btn-save-plan-changes'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('plan-1', {
        title: 'Checkout',
        suiteId: null,
        plans: [
          {
            title: 'Pay',
            description: 'Pay by card',
            steps: [step],
            metadata: { caseId: 'case-a' },
          },
          { title: 'Legacy', description: 'No id yet', steps: [step] },
        ],
      }),
    );
    expect(
      await within(view.getByTestId('test-case-CT-02')).findByRole('button', { name: 'Histórico' }),
    ).toBeInTheDocument();
  });

  it('hides deletion without the delete permission', async () => {
    const view = renderView(client(), 'edit');
    await openPlan(view);
    expect(view.getByTestId('btn-edit-test-CT-01')).toBeInTheDocument();
    expect(view.queryByTestId('btn-delete-test-CT-01')).not.toBeInTheDocument();
    expect(view.queryByTestId('btn-delete-current-plan')).not.toBeInTheDocument();
    expect(view.getByTestId('btn-save-plan-changes')).toBeInTheDocument();
  });

  it('leaves only reading and history to members who can view test plans', async () => {
    const view = renderView(client(), 'view', true);
    expect(view.queryByTestId('btn-new-test-plan')).not.toBeInTheDocument();
    expect(view.queryByTestId('tab-create-test-plan')).not.toBeInTheDocument();
    expect(view.queryByTestId(`btn-delete-plan-${savedPlan.id}`)).not.toBeInTheDocument();
    await openPlan(view);
    expect(view.queryByTestId('btn-add-test-case')).not.toBeInTheDocument();
    expect(view.queryByTestId('btn-save-plan-changes')).not.toBeInTheDocument();
    expect(view.queryByTestId('btn-edit-test-CT-01')).not.toBeInTheDocument();
    expect(
      within(view.getByTestId('test-case-CT-01')).getByRole('button', { name: 'Histórico' }),
    ).toBeInTheDocument();
    expect((view.getByLabelText('Título do Test Plan') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('TestSuiteTree without write permissions', () => {
  it('omits the actions whose handlers are not provided', () => {
    const view = render(
      <TestSuiteTree
        suites={[{ id: 's', workspaceId: 'ws', name: 'Smoke', createdAt: ISO, updatedAt: ISO }]}
        plans={[{ ...savedPlan, suiteId: 's' }]}
        onOpenPlan={vi.fn()}
        onExportSuite={vi.fn()}
      />,
    );
    expect(view.queryByRole('button', { name: /Nova suíte/ })).not.toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Smoke' }));
    expect(view.queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: /^Editar$/ })).not.toBeInTheDocument();
  });
});
