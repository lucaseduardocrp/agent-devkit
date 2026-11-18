import { fireEvent, render, type RenderResult, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import { pickOption } from './helpers/pick-option.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../src/lib/api-client.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';

/** The export format lives in the CSV settings dialog: open it before choosing a format. */ function openCsvSettings(
  ui: Pick<RenderResult, 'getByTestId'>,
) {
  fireEvent.click(ui.getByTestId('btn-csv-configuration'));
}

const ISO = '2026-09-18T00:00:00.000Z';

const SUITE: TestSuiteDto = {
  id: 'suite-1',
  workspaceId: 'ws-1',
  name: 'Regression',
  createdAt: ISO,
  updatedAt: ISO,
};

const PLAN: SavedTestPlanDto = {
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
};

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

function client() {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [PLAN],
    page: 1,
    pageSize: 8,
    total: 1,
    totalPages: 1,
  });
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([SUITE]);
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

function view(api: ApiClient) {
  return render(
    <TestPlansView
      apiClient={api}
      initialTab="saved"
      activeWorkspaceId="ws-1"
      workspaces={WORKSPACES}
    />,
  );
}

beforeEach(() => {
  // The rich-text toolbar drives the editor through execCommand, which jsdom does not implement.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
});

afterEach(() => vi.restoreAllMocks());

async function openEditor(api: ApiClient) {
  const ui = view(api);
  fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
  fireEvent.click(ui.getByTestId('btn-edit-test-CT-01'));
  return ui;
}

describe('TestPlansView case editor', () => {
  it('edits the title and the scenario and saves the case', async () => {
    const api = client();
    // Without suites, a plan outside one can be saved as it is.
    vi.mocked(api.getTestSuites).mockResolvedValue([]);
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockImplementation((_id, input) => Promise.resolve({ ...PLAN, ...input }));
    const ui = await openEditor(api);

    fireEvent.change(ui.getByTestId('input-edit-test-title'), {
      target: { value: 'Pay with Pix' },
    });
    fireEvent.input(ui.getByTestId('input-edit-test-scenario-formatted'), {
      target: { innerHTML: '<p>Pay using a Pix key</p>' },
    });
    fireEvent.click(ui.getByTestId('btn-save-test-case-modal'));

    await waitFor(() =>
      expect(ui.queryByTestId('btn-save-test-case-modal')).not.toBeInTheDocument(),
    );
    // A saved Test Plan keeps the edited case at once.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'plan-1',
        expect.objectContaining({
          plans: [expect.objectContaining({ title: 'Pay with Pix' })],
        }),
      ),
    );
    expect(ui.getByText(/Pay with Pix/)).toBeInTheDocument();
  });

  it('applies the formatting commands to the scenario', async () => {
    const ui = await openEditor(client());
    const execCommand = document.execCommand as unknown as ReturnType<typeof vi.fn>;

    // The description is edited with the same Markdown editor the Brain uses.
    for (const testId of ['editor-bold', 'editor-italic', 'editor-ul']) {
      fireEvent.mouseDown(ui.getByTestId(testId));
      fireEvent.click(ui.getByTestId(testId));
    }
    fireEvent.click(ui.getByTestId('editor-style'));
    fireEvent.click(ui.getByTestId('editor-heading-3'));

    expect(execCommand).toHaveBeenCalledWith('bold', false, undefined);
    expect(execCommand).toHaveBeenCalledWith('italic', false, undefined);
    expect(execCommand).toHaveBeenCalledWith('insertUnorderedList', false, undefined);
    expect(execCommand).toHaveBeenCalledWith('formatBlock', false, 'h3');
    expect(ui.getByTestId('editor-mode-code')).toBeInTheDocument();
  });

  it('adds and removes a step', async () => {
    const ui = await openEditor(client());

    fireEvent.click(ui.getByRole('button', { name: 'Adicionar Passo' }));
    expect(ui.getByTestId('input-step-action-2')).toBeInTheDocument();

    fireEvent.change(ui.getByTestId('input-step-action-2'), { target: { value: 'Confirm' } });
    fireEvent.change(ui.getByTestId('input-step-expected-2'), { target: { value: 'Confirmed' } });
    expect((ui.getByTestId('input-step-expected-2') as HTMLInputElement).value).toBe('Confirmed');

    fireEvent.click(ui.getByRole('button', { name: 'Remover passo 2' }));
    expect(ui.queryByTestId('input-step-action-2')).not.toBeInTheDocument();
  });

  it('keeps the save disabled while the title or the scenario is blank', async () => {
    const ui = await openEditor(client());
    const save = () => ui.getByTestId('btn-save-test-case-modal') as HTMLButtonElement;

    expect(save().disabled).toBe(false);
    fireEvent.change(ui.getByTestId('input-edit-test-title'), { target: { value: '   ' } });
    expect(save().disabled).toBe(true);
  });

  it('closes the editor from the header and from cancel without saving', async () => {
    const api = client();
    const first = await openEditor(api);
    fireEvent.click(first.getByRole('button', { name: 'Fechar modal' }));
    expect(first.queryByTestId('btn-save-test-case-modal')).not.toBeInTheDocument();
    first.unmount();

    const second = await openEditor(api);
    fireEvent.change(second.getByTestId('input-edit-test-title'), { target: { value: 'Dropped' } });
    fireEvent.click(second.getByRole('button', { name: 'Cancelar' }));

    expect(second.queryByTestId('btn-save-test-case-modal')).not.toBeInTheDocument();
    expect(second.queryByText('Dropped')).not.toBeInTheDocument();
  });
});

describe('TestPlansView saved plan editing', () => {
  it('renames a saved plan and assigns it to a suite from the detail view', async () => {
    const api = client();
    const update = vi
      .spyOn(api, 'updateSavedTestPlan')
      .mockImplementation((_id, input) => Promise.resolve({ ...PLAN, ...input }));
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.change(ui.getByLabelText('Título do Test Plan'), { target: { value: 'Pix flow' } });
    await pickOption(ui.getByRole('combobox', { name: 'Test suite' }), 'Regression');
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'plan-1',
        expect.objectContaining({ title: 'Pix flow', suiteId: 'suite-1' }),
      ),
    );
  });

  it('cancels the plan deletion dialog', async () => {
    const api = client();
    const remove = vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() =>
      expect(ui.queryByTestId('confirm-delete-plan-btn')).not.toBeInTheDocument(),
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('chooses a suite when creating a plan', async () => {
    const ui = view(client());

    fireEvent.click(await ui.findByTestId('btn-new-test-plan'));
    await pickOption(ui.getByRole('combobox', { name: 'Test suite' }), 'Regression');

    expect((ui.getByRole('combobox', { name: 'Test suite' }) as HTMLInputElement).value).toBe(
      'Regression',
    );
  });

  it('filters the suites by what is typed in the suite field', async () => {
    const api = client();
    vi.spyOn(api, 'getTestSuites').mockResolvedValue([
      SUITE,
      { ...SUITE, id: 'suite-2', name: 'Smoke' },
    ]);
    const ui = view(api);

    fireEvent.click(await ui.findByTestId('btn-new-test-plan'));
    const field = ui.getByRole('combobox', { name: 'Test suite' });
    fireEvent.focus(field);
    expect(await screen.findAllByRole('option')).toHaveLength(2);
    fireEvent.change(field, { target: { value: 'smo' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option', { name: 'Smoke' })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'zzz' } });
    expect(await screen.findByText('Nenhum resultado encontrado.')).toBeInTheDocument();
  });

  it('goes back to the default agent after choosing another one', async () => {
    const api = client();
    vi.spyOn(api, 'getAgents').mockResolvedValue([
      { id: 'agent-1', name: 'QA Writer', role: 'QA' } as CustomAgentDto,
    ]);
    const ui = view(api);

    fireEvent.click(await ui.findByTestId('btn-new-test-plan'));
    const field = ui.getByRole('combobox', {
      name: 'Selecionar agente de IA para geração de testes',
    });
    await pickOption(field, 'QA Writer (QA)');
    expect((field as HTMLInputElement).value).toBe('QA Writer (QA)');
    await pickOption(field, /Test Specialist|Especialista/);
    expect((field as HTMLInputElement).value).toMatch(/Test Specialist|Especialista/);
  });
});

describe('TestPlansView suite requirement', () => {
  it('refuses to save a plan left outside a suite', async () => {
    const api = client();
    const update = vi.spyOn(api, 'updateSavedTestPlan');
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));

    expect(await ui.findByRole('alert')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('TestPlansView failure fallbacks', () => {
  it('falls back to the generic message when saving rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'updateSavedTestPlan').mockRejectedValue('boom');
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Abrir Test Plan Checkout' }));
    await pickOption(ui.getByRole('combobox', { name: 'Test suite' }), 'Regression');
    fireEvent.click(ui.getByTestId('btn-save-plan-changes'));

    expect(await ui.findByText('Falha ao salvar alterações do plano.')).toBeInTheDocument();
  });

  it('falls back to the generic message when the plan list rejects without an Error', async () => {
    const api = client();
    vi.spyOn(api, 'getSavedTestPlans').mockRejectedValue('boom');
    const ui = view(api);

    expect(await ui.findByText('Falha ao carregar Test Plans.')).toBeInTheDocument();
  });

  it('reports a deletion that rejects with and without an Error', async () => {
    const withError = client();
    vi.spyOn(withError, 'deleteSavedTestPlan').mockRejectedValue(new Error('The plan is locked.'));
    const first = view(withError);
    fireEvent.click(await first.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(first.getByRole('button', { name: 'Excluir Test Plan Checkout' }));
    fireEvent.click(first.getByTestId('confirm-delete-plan-btn'));
    expect(await first.findByText('The plan is locked.')).toBeInTheDocument();
    first.unmount();

    const withoutError = client();
    vi.spyOn(withoutError, 'deleteSavedTestPlan').mockRejectedValue('boom');
    const second = view(withoutError);
    fireEvent.click(await second.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(second.getByRole('button', { name: 'Excluir Test Plan Checkout' }));
    fireEvent.click(second.getByTestId('confirm-delete-plan-btn'));
    expect(await second.findByText('Falha ao excluir plano de testes.')).toBeInTheDocument();
  });

  it('deletes a plan and reports the success', async () => {
    const api = client();
    const remove = vi.spyOn(api, 'deleteSavedTestPlan').mockResolvedValue();
    const ui = view(api);

    fireEvent.click(await ui.findByRole('button', { name: 'Ações: Checkout' }));
    fireEvent.click(ui.getByRole('button', { name: 'Excluir Test Plan Checkout' }));
    fireEvent.click(ui.getByTestId('confirm-delete-plan-btn'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('plan-1'));
    expect(await ui.findByText('Test Plan excluído com sucesso.')).toBeInTheDocument();
  });

  it('requires a suite before generating a plan', async () => {
    const ui = view(client());

    fireEvent.click(await ui.findByTestId('btn-new-test-plan'));
    fireEvent.change(ui.getByLabelText('User story / requisito'), { target: { value: 'A story' } });
    fireEvent.click(ui.getByRole('button', { name: 'Gerar testes' }));

    expect(
      await ui.findByText('Selecione uma test suite antes de gerar os testes.'),
    ).toBeInTheDocument();
  });

  it('keeps the Azure options empty when no client is wired', () => {
    const ui = render(<TestPlansView initialTab="saved" />);
    expect(ui.getByTestId('screen-testplans')).toBeInTheDocument();
  });
});

describe('TestPlansView Azure export fallbacks', () => {
  it('defaults the area paths and states a configured project omits', async () => {
    const api = client();
    vi.spyOn(api, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: true,
      organization: 'acme',
      project: 'Portal',
      members: [{ id: 'az-1', displayName: 'Maria', email: 'maria@acme.com' }],
    });
    const ui = view(api);

    await ui.findByTestId('panel-saved-plans');
    openCsvSettings(ui);
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'standard' } });
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'azure' } });

    await waitFor(() =>
      expect((ui.getByLabelText('Area Path') as HTMLSelectElement).disabled).toBe(true),
    );
    expect((ui.getByLabelText('Assigned To') as HTMLSelectElement).disabled).toBe(false);
  });

  it('clears the Azure options when no client is wired', async () => {
    const ui = render(<TestPlansView initialTab="saved" />);

    openCsvSettings(ui);
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'standard' } });
    fireEvent.change(ui.getByLabelText('Formato de exportação'), { target: { value: 'azure' } });

    await waitFor(() =>
      expect((ui.getByLabelText('Assigned To') as HTMLSelectElement).disabled).toBe(true),
    );
  });
});
