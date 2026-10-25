import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';
import type * as SuiteZip from '../src/features/testplans/export-suite-zip.js';

const zip = vi.hoisted(() => ({ files: [] as { path: string }[] }));

vi.mock('../src/features/testplans/export-suite-zip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SuiteZip>();
  return {
    ...actual,
    createSuiteZip: (files: { path: string; content: string }[]) => {
      zip.files = files;
      return actual.createSuiteZip(files);
    },
  };
});

// The provider dialogs have their own suites; here they only hand back their outcomes.
vi.mock('../src/features/testplans/PublishTestSuiteModal.js', () => ({
  PublishTestSuiteModal: (props: {
    onClose: () => void;
    onPublished: (result: {
      remoteUrl?: string;
      workItems?: { type: string; id: string }[];
    }) => void;
  }) => (
    <div role="dialog">
      <button type="button" onClick={props.onClose}>
        close-publish
      </button>
      <button type="button" onClick={() => props.onPublished({})}>
        publish-plain
      </button>
      <button
        type="button"
        onClick={() =>
          props.onPublished({
            remoteUrl: 'https://remote/suite',
            workItems: [{ type: 'Bug', id: '42' }],
          })
        }
      >
        publish-one
      </button>
      <button
        type="button"
        onClick={() =>
          props.onPublished({
            workItems: [
              { type: 'Bug', id: '1' },
              { type: 'Task', id: '2' },
            ],
          })
        }
      >
        publish-many
      </button>
    </div>
  ),
}));

vi.mock('../src/features/testplans/ImportTestCasesModal.js', () => ({
  ImportTestCasesModal: (props: { onClose: () => void; onImported: () => void }) => (
    <div role="dialog">
      <button type="button" onClick={props.onClose}>
        close-import
      </button>
      <button type="button" onClick={props.onImported}>
        finish-import
      </button>
    </div>
  ),
}));

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
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([...(options.suites ?? [])]);
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

async function openSuiteMenu(ui: ReturnType<typeof view>, action: string) {
  await ui.findByTestId('test-suite-tree');
  fireEvent.click(await ui.findByRole('button', { name: 'Ações: Regression' }));
  fireEvent.click(ui.getByRole('button', { name: action }));
}

let createUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createUrl = vi.fn(() => 'blob:export');
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  zip.files = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TestPlansView agents and creation shortcuts', () => {
  it('falls back to the default agent when the agents cannot be loaded', async () => {
    const api = client();
    vi.spyOn(api, 'getAgents').mockRejectedValue(new Error('offline'));
    const ui = view(api, 'create');

    await waitFor(() => expect(api.getAgents).toHaveBeenCalled());
    const select = ui.getByLabelText('Selecionar agente de IA para geração de testes');
    expect(within(select).getAllByRole('option')).toHaveLength(1);
  });

  it('starts a plan inside the suite picked from the tree', async () => {
    const ui = view(client({ suites: [suite()] }));

    await openSuiteMenu(ui, 'Criar Test Plan');

    expect(ui.getByTestId('panel-create-plan')).toBeInTheDocument();
    expect((ui.getByLabelText('Test suite') as HTMLSelectElement).value).toBe('suite-1');
  });

  it('moves a freshly generated plan to another suite', async () => {
    const api = client({ suites: [suite(), suite({ id: 'suite-2', name: 'Smoke' })] });
    vi.spyOn(api, 'generateTestPlan').mockResolvedValue({
      plans: [],
      csv: '',
      savedPlan: plan({ suiteId: 'suite-1' }),
    });
    const ui = view(api, 'create');

    await waitFor(() => expect(ui.getByLabelText('Test suite')).toHaveTextContent('Smoke'));
    fireEvent.change(ui.getByLabelText('Test suite'), { target: { value: 'suite-1' } });
    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Pay' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));

    const target = (await ui.findByLabelText('Test Plans salvos')) as HTMLSelectElement;
    expect(target.value).toBe('suite-1');
    fireEvent.change(target, { target: { value: 'suite-2' } });
    expect(target.value).toBe('suite-2');
  });
});

describe('TestPlansView generated plan in the create tab', () => {
  it('renames, saves and edits the cases of a freshly generated plan', async () => {
    const generated = plan({
      plans: [
        { title: 'First', description: 'One', steps: [] },
        { title: 'Second', description: 'Two', steps: [] },
      ],
    });
    const api = client();
    vi.spyOn(api, 'generateTestPlan').mockResolvedValue({
      plans: [],
      csv: '',
      savedPlan: generated,
    });
    const update = vi.spyOn(api, 'updateSavedTestPlan').mockResolvedValue(generated);
    const ui = view(api, 'create');

    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Pay' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    await ui.findByTestId('test-result');

    fireEvent.change(ui.getByLabelText('Título do Test Plan'), { target: { value: 'Renamed' } });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('plan-1', expect.objectContaining({ title: 'Renamed' })),
    );

    fireEvent.click(ui.getByTestId('btn-edit-test-CT-01'));
    fireEvent.change(ui.getByLabelText('Título do caso de teste'), {
      target: { value: 'First edited' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Salvar Caso de Teste' }));

    expect(await ui.findByText('CT-01 — First edited')).toBeInTheDocument();
    expect(ui.getByText('CT-02 — Second')).toBeInTheDocument();

    fireEvent.click(ui.getByTestId('btn-delete-test-CT-02'));
    expect(ui.queryByText('CT-02 — Second')).not.toBeInTheDocument();
  });

  it('opens a plan from the edit action of its card', async () => {
    const ui = view(client({ plans: [plan()] }));

    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Editar Checkout' }));

    expect(ui.getByTestId('saved-plan-detail')).toBeInTheDocument();
  });
});

describe('TestPlansView saving a plan', () => {
  async function opened(api: ApiClient) {
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    return ui;
  }

  it('saves twice in a row and keeps the plan when the tree list is unavailable', async () => {
    const api = client({ plans: [plan()] });
    vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
      items: [plan()],
      page: 1,
      pageSize: 8,
      total: 9,
      totalPages: 2,
    });
    vi.spyOn(api, 'getAllSavedTestPlans').mockRejectedValue(new Error('offline'));
    const update = vi.spyOn(api, 'updateSavedTestPlan').mockResolvedValue(plan({ title: 'New' }));
    const ui = await opened(api);

    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    expect(await ui.findByText('Alterações salvas com sucesso!')).toBeInTheDocument();
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[0]![1].plans[0]).not.toHaveProperty('metadata');
  });

  it('reports a save failure that carries no message', async () => {
    const api = client({ plans: [plan()] });
    vi.spyOn(api, 'updateSavedTestPlan').mockRejectedValue('boom');
    const ui = await opened(api);

    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));

    expect(await ui.findByRole('alert')).toHaveTextContent('Falha ao salvar alterações do plano.');
  });

  it('saves a case without steps and shows the API error message', async () => {
    const api = client({
      plans: [plan({ plans: [{ title: 'No steps', description: 'Nothing' } as never] })],
    });
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockRejectedValue(new Error('Plan is locked.'));
    const ui = await opened(api);

    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));

    expect(await ui.findByRole('alert')).toHaveTextContent('Plan is locked.');
    expect(update.mock.calls[0]![1].plans[0]!.steps).toEqual([]);
  });

  it('keeps an empty plan editable after a failed regeneration', async () => {
    const api = client();
    vi.spyOn(api, 'generateTestPlan')
      .mockResolvedValueOnce({ plans: [], csv: '', savedPlan: plan() })
      .mockRejectedValue(new Error('generator down'));
    const update = vi.spyOn(api, 'updateSavedTestPlan');
    const ui = view(api, 'create');

    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'Pay' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    await ui.findByTestId('test-result');
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));
    expect(await ui.findByRole('alert')).toHaveTextContent('generator down');

    fireEvent.click(ui.getByTestId('tab-saved-test-plans'));
    expect(ui.queryByTestId('test-result')).not.toBeInTheDocument();
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar CSV' }));
    expect(await ui.findByRole('alert')).toHaveTextContent('pelo menos um passo');

    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-add-test-case'));
    expect(ui.getByTestId('test-case-CT-01')).toHaveTextContent('Novo Caso de Teste 1');
  });
});

describe('TestPlansView CSV export failures', () => {
  async function exportOpened(api: ApiClient) {
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'standard' } });
    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar CSV' }));
    return ui;
  }

  it('flags a case without steps', async () => {
    const stepless = plan({
      plans: [{ title: 'No steps', description: 'Nothing to do' } as never],
    });
    const ui = view(client({ plans: [stepless] }));
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    expect(ui.getByTestId('test-case-CT-01')).toHaveTextContent('0');

    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByRole('button', { name: 'Exportar CSV' }));

    expect(await ui.findByRole('alert')).toHaveTextContent('pelo menos um passo');
  });

  it('shows the message of an unexpected download error', async () => {
    createUrl.mockImplementation(() => {
      throw new Error('Blob storage full');
    });
    const ui = await exportOpened(client({ plans: [plan()] }));

    expect(await ui.findByRole('alert')).toHaveTextContent('Blob storage full');
  });

  it('falls back to a generic message for a non-error failure', async () => {
    createUrl.mockImplementation(() => {
      throw 'denied';
    });
    const ui = await exportOpened(client({ plans: [plan()] }));

    expect(await ui.findByRole('alert')).toHaveTextContent(
      'Não foi possível baixar o CSV no momento.',
    );
  });
});

describe('TestPlansView suite export', () => {
  it('names files of untitled plans after a placeholder', async () => {
    const ui = view(
      client({ plans: [plan({ suiteId: 'suite-1', title: '   ' })], suites: [suite()] }),
    );
    fireEvent.change(await ui.findByLabelText('Formato de exportação'), {
      target: { value: 'standard' },
    });

    await openSuiteMenu(ui, 'Exportar suite (.zip)');

    await waitFor(() =>
      expect(zip.files.map((file) => file.path)).toEqual(['Regression/01 - Test Plan.csv']),
    );
  });

  it('reports a suite whose plans cannot be fetched', async () => {
    const api = client({ plans: [plan({ suiteId: 'suite-1' })], suites: [suite()] });
    const ui = view(api);
    await ui.findByTestId('test-suite-tree');
    vi.mocked(api.getSavedTestPlans).mockRejectedValue(new Error('offline'));

    await openSuiteMenu(ui, 'Exportar suite (.zip)');

    expect(await ui.findByRole('alert')).toHaveTextContent(
      'Não foi possível baixar o CSV no momento.',
    );
  });
});

describe('TestPlansView deleting plans', () => {
  it('deletes the plan being edited and returns to the list', async () => {
    const api = client({ plans: [plan()] });
    const remove = vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    const ui = view(api);
    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));

    fireEvent.click(ui.getByRole('button', { name: 'Ações' }));
    fireEvent.click(ui.getByTestId('btn-delete-current-plan'));
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('plan-1'));
    expect(await ui.findByText('Test Plan excluído com sucesso.')).toBeInTheDocument();
    expect(ui.queryByTestId('saved-plan-detail')).not.toBeInTheDocument();
  });

  it('goes back a page after deleting the last plan of the page', async () => {
    const api = client();
    vi.spyOn(api, 'getSavedTestPlans').mockImplementation((page) =>
      Promise.resolve({
        items: [page === 2 ? plan({ id: 'plan-2', title: 'Last' }) : plan()],
        page: page ?? 1,
        pageSize: 8,
        total: 9,
        totalPages: 2,
      }),
    );
    vi.spyOn(api, 'getAllSavedTestPlans').mockResolvedValue([plan()]);
    vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Próxima página' }));
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Last' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Last' }));
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));

    expect(await ui.findByText('Página 1 de 2')).toBeInTheDocument();
  });

  it('closes the delete dialog with Escape', async () => {
    const ui = view(client({ plans: [plan()] }));
    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Checkout' }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(ui.queryByTestId('confirm-delete-plan-btn')).not.toBeInTheDocument();
  });
});

describe('TestPlansView deleting suites', () => {
  it('cancels and dismisses the suite deletion dialog', async () => {
    const ui = view(client({ suites: [suite()] }));

    await openSuiteMenu(ui, 'Excluir');
    fireEvent.click(ui.getByRole('button', { name: 'Cancelar' }));
    expect(ui.queryByTestId('confirm-delete-suite-btn')).not.toBeInTheDocument();

    await openSuiteMenu(ui, 'Excluir');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(ui.queryByTestId('confirm-delete-suite-btn')).not.toBeInTheDocument();
  });

  it('reports a failure that carries no message', async () => {
    const api = client({ suites: [suite()] });
    vi.spyOn(api, 'deleteTestSuite').mockRejectedValue('nope');
    const ui = view(api);

    await openSuiteMenu(ui, 'Excluir');
    fireEvent.change(ui.getByTestId('delete-suite-confirm-input'), {
      target: { value: 'Regression' },
    });
    fireEvent.click(ui.getByTestId('confirm-delete-suite-btn'));

    expect(await ui.findByText('Falha ao carregar Test Plans.')).toBeInTheDocument();
  });
});

describe('TestPlansView provider dialogs', () => {
  it.each([
    ['publish-plain', 'Suite de testes publicada com sucesso.'],
    ['publish-one', 'Suite de testes publicada e vinculada ao Bug #42.'],
    ['publish-many', 'Suite de testes publicada e vinculada a 2 work items.'],
  ])('announces the %s outcome', async (button, message) => {
    const ui = view(client({ suites: [suite()] }));

    await openSuiteMenu(ui, 'Publicar suite');
    fireEvent.click(ui.getByRole('button', { name: button }));

    expect(await ui.findByText(message)).toBeInTheDocument();
    expect(ui.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the publish dialog without announcing anything', async () => {
    const ui = view(client({ suites: [suite()] }));

    await openSuiteMenu(ui, 'Publicar suite');
    fireEvent.click(ui.getByRole('button', { name: 'close-publish' }));

    expect(ui.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reloads suites and plans after an import, and closes without importing', async () => {
    const api = client({ suites: [suite()] });
    const ui = view(api);

    await openSuiteMenu(ui, 'Importar casos de teste');
    fireEvent.click(ui.getByRole('button', { name: 'close-import' }));
    expect(ui.queryByRole('dialog')).not.toBeInTheDocument();

    const suitesBefore = vi.mocked(api.getTestSuites).mock.calls.length;
    const plansBefore = vi.mocked(api.getSavedTestPlans).mock.calls.length;
    fireEvent.click(ui.getByTestId('btn-import-from-provider'));
    fireEvent.click(ui.getByRole('button', { name: 'finish-import' }));

    expect(ui.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(vi.mocked(api.getTestSuites).mock.calls.length).toBeGreaterThan(suitesBefore);
      expect(vi.mocked(api.getSavedTestPlans).mock.calls.length).toBeGreaterThan(plansBefore);
    });
  });
});
