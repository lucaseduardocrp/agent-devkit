import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportTestCasesModal } from '../src/features/testplans/ImportTestCasesModal.js';
import { PublishTestSuiteModal } from '../src/features/testplans/PublishTestSuiteModal.js';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';

/** A promise the test settles by hand, after the component that asked for it is gone. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => act(async () => {});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ImportTestCasesModal answers that arrive after closing', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late provider list (%s)', async (outcome) => {
    const providers = deferred<unknown[]>();
    const api = { getTestManagementProviders: vi.fn(() => providers.promise) };
    const ui = render(
      <ImportTestCasesModal
        apiClient={api as unknown as ApiClient}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(api.getTestManagementProviders).toHaveBeenCalled();
    ui.unmount();
    if (outcome === 'resolve') providers.resolve([]);
    else providers.reject(new Error('offline'));
    await flush();
  });
});

describe('PublishTestSuiteModal answers that arrive after closing', () => {
  const suite = { id: 'suite-1', name: 'Regression' } as TestSuiteDto;
  const template = {
    id: 'tpl-1',
    workspaceId: 'ws',
    name: 'Casos',
    entityType: 'test_case',
    providerId: 'azure_devops',
    scope: '',
    itemType: 'Test Case',
    createdAt: '',
    updatedAt: '',
    rules: [],
  };

  function client() {
    const late = {
      sources: deferred<unknown[]>(),
      suites: deferred<unknown[]>(),
      preview: deferred<unknown>(),
      board: deferred<unknown[]>(),
    };
    const api = {
      getTestSuiteFieldSources: vi.fn(() => late.sources.promise),
      getTestSuiteProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'azure_devops', name: 'Azure DevOps', configured: true }]),
      getRemoteTestPlans: vi.fn().mockResolvedValue([{ id: '7', name: 'Regression plan' }]),
      getRemoteTestSuites: vi.fn(() => late.suites.promise),
      getFieldMappingTemplates: vi.fn().mockResolvedValue([template]),
      getTestCaseFieldCatalog: vi.fn().mockResolvedValue([]),
      previewTestSuiteFields: vi.fn(() => late.preview.promise),
      getPbiItems: vi.fn(() => late.board.promise),
    };
    return { api, late };
  }

  function open(api: unknown) {
    return render(
      <PublishTestSuiteModal
        apiClient={api as ApiClient}
        suite={suite}
        onClose={vi.fn()}
        onPublish={vi.fn()}
        onPublished={vi.fn()}
      />,
    );
  }

  it.each(['resolve', 'reject'] as const)(
    'ignores late suites, previews, sources and board items (%s)',
    async (outcome) => {
      const { api, late } = client();
      const ui = open(api);
      const dialog = screen.getByRole('dialog');
      fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
        target: { value: 'azure_devops' },
      });
      fireEvent.change(within(dialog).getByLabelText('Destino'), {
        target: { value: 'existing' },
      });
      const plan = await within(dialog).findByLabelText('Test Plan de destino');
      await waitFor(() => expect(within(plan).getAllByRole('option')).toHaveLength(2));
      fireEvent.change(plan, { target: { value: '7' } });
      const region = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
      fireEvent.change(await within(region).findByRole('combobox', { name: 'Template salvo' }), {
        target: { value: 'tpl-1' },
      });
      await waitFor(() => expect(api.previewTestSuiteFields).toHaveBeenCalled());
      expect(api.getRemoteTestSuites).toHaveBeenCalled();
      expect(api.getPbiItems).toHaveBeenCalled();

      ui.unmount();
      for (const request of Object.values(late)) {
        if (outcome === 'resolve') request.resolve([] as never);
        else request.reject(new Error('late'));
      }
      await flush();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores late providers and plans (%s)',
    async (outcome) => {
      const providers = deferred<unknown[]>();
      const first = client();
      first.api.getTestSuiteProviders.mockReturnValue(providers.promise);
      open(first.api).unmount();

      const plans = deferred<unknown[]>();
      const second = client();
      second.api.getRemoteTestPlans.mockReturnValue(plans.promise);
      const ui = open(second.api);
      const dialog = screen.getByRole('dialog');
      fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
        target: { value: 'azure_devops' },
      });
      fireEvent.change(within(dialog).getByLabelText('Destino'), {
        target: { value: 'existing' },
      });
      await waitFor(() => expect(second.api.getRemoteTestPlans).toHaveBeenCalled());
      ui.unmount();

      for (const request of [providers, plans]) {
        if (outcome === 'resolve') request.resolve([]);
        else request.reject(new Error('late'));
      }
      await flush();
    },
  );
});

describe('TestPlansView saved plans', () => {
  const ISO = '2026-09-18T00:00:00.000Z';
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

  function plan(overrides: Partial<SavedTestPlanDto> = {}): SavedTestPlanDto {
    return {
      id: 'plan-1',
      workspaceId: 'ws-1',
      title: 'Checkout',
      plans: [{ title: 'Pay', description: 'Pay with card', steps: [] }],
      createdAt: ISO,
      updatedAt: ISO,
      ...overrides,
    };
  }

  function client(plans: SavedTestPlanDto[] = [], suites: TestSuiteDto[] = []) {
    const api = new ApiClient();
    vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
      items: plans,
      page: 1,
      pageSize: 8,
      total: plans.length,
      totalPages: 1,
    });
    vi.spyOn(api, 'getTestSuites').mockResolvedValue(suites);
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

  it('replaces a regenerated plan already in the list', async () => {
    const api = client([plan(), plan({ id: 'plan-2', title: 'Other' })]);
    vi.spyOn(api, 'generateTestPlan').mockResolvedValue({
      plans: [],
      csv: '',
      savedPlan: plan({ title: 'Checkout v2' }),
    });
    const ui = view(api, 'create');
    await waitFor(() => expect(api.getSavedTestPlans).toHaveBeenCalled());
    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Pay' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    await ui.findByTestId('test-result');
    expect(api.generateTestPlan).toHaveBeenCalled();
    ui.unmount();
  });

  it('hides the deletion notice after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const other = plan({ id: 'plan-2', title: 'Other' });
    const api = client([plan(), other]);
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Other' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Other' }));
    vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));
    const notice = await ui.findByText('Test Plan excluído com sucesso.');
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(notice).not.toBeInTheDocument();
  });

  it('keeps the plan and suite dialogs open while they delete', async () => {
    const suite = {
      id: 'suite-1',
      workspaceId: 'ws-1',
      name: 'Regression',
      createdAt: ISO,
      updatedAt: ISO,
    };
    const api = client([plan()], [suite]);
    const deletion = deferred<void>();
    vi.spyOn(api, 'deleteSavedTestPlan').mockReturnValue(deletion.promise);
    const suiteDeletion = deferred<void>();
    vi.spyOn(api, 'deleteTestSuite').mockReturnValue(suiteDeletion.promise);
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Checkout' }));
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(ui.getByTestId('confirm-delete-plan-btn')).toBeInTheDocument();
    deletion.resolve();
    await waitFor(() =>
      expect(ui.queryByTestId('confirm-delete-plan-btn')).not.toBeInTheDocument(),
    );

    await ui.findByTestId('test-suite-tree');
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Regression' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir' }));
    fireEvent.change(ui.getByTestId('delete-suite-confirm-input'), {
      target: { value: 'Regression' },
    });
    fireEvent.click(ui.getByTestId('confirm-delete-suite-btn'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(ui.getByTestId('confirm-delete-suite-btn')).toBeInTheDocument();
    suiteDeletion.resolve();
    await waitFor(() =>
      expect(ui.queryByTestId('confirm-delete-suite-btn')).not.toBeInTheDocument(),
    );
  });
});
