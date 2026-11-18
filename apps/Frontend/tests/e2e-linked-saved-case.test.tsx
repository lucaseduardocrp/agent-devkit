import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E2eEditSavedCase,
  E2eLinkedSavedCase,
  useSavedCaseLink,
} from '../src/features/e2e/E2eLinkedSavedCase.js';
import { E2eSavedCasePicker } from '../src/features/e2e/E2eSavedCasePicker.js';
import type { E2eTestDetail } from '../src/features/e2e/e2e-types.js';
import type { ApiClient, SavedTestPlanDto } from '../src/lib/api-client.js';
import type { TestCase } from '../src/features/testplans/TestPlansView.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';

const { fixResults } = vi.hoisted(() => ({ fixResults: vi.fn() }));
const TURN = {
  messages: [{ role: 'user' as const, content: 'Start from the menu' }],
  testCase: { title: 'Login', description: '', steps: [] },
};

// The case editor has its own tests: here it only hands back what the user saved.
vi.mock('../src/features/testplans/TestCaseModal.js', () => ({
  TestCaseModal: ({
    testCase,
    onSave,
    onClose,
    fixWithAi,
  }: {
    testCase: TestCase;
    onSave: (testCase: TestCase) => void;
    onClose: () => void;
    fixWithAi: {
      ask: (turn: typeof TURN) => Promise<unknown>;
      saveAndRegenerate: (testCase: TestCase) => Promise<void>;
    };
  }) => (
    <div data-testid="case-modal">
      <span>{testCase.id}</span>
      <button onClick={() => void fixWithAi.ask(TURN).then(fixResults)}>fix-ask</button>
      <button
        onClick={() =>
          void fixWithAi.saveAndRegenerate({ ...testCase, title: 'Login v3' }).then(
            () => fixResults('regenerated'),
            (reason: Error) => fixResults(`failed: ${reason.message}`),
          )
        }
      >
        fix-regenerate
      </button>
      <button onClick={() => onSave({ ...testCase, title: 'Login v2', steps: undefined })}>
        save-case
      </button>
      <button onClick={() => onSave({ ...testCase, metadata: undefined })}>save-bare</button>
      <button onClick={onClose}>close-case</button>
    </div>
  ),
}));

const plan: SavedTestPlanDto = {
  id: 'plan-1',
  workspaceId: 'ws',
  title: 'Plano de login',
  suiteId: 'suite-1',
  plans: [
    { title: 'Outro', description: '', steps: [], metadata: { caseId: 'c-0' } },
    {
      title: 'Login',
      description: 'Valida o login',
      steps: [{ order: 1, action: 'Abrir', expectedResult: 'Aberto' }],
      metadata: { caseId: 'c-1', importedFrom: 'azure_devops' },
    },
  ],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const suites = [{ id: 'suite-1', name: 'Checkout' }];

const base = {
  id: 'test-1',
  creationId: 'run-1',
  title: 'Login',
  externalCase: null,
} as unknown as E2eTestDetail;
const linked = { ...base, savedCase: { planId: 'plan-1', caseId: 'c-1' } } as E2eTestDetail;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getSavedTestPlan: vi.fn().mockResolvedValue(plan),
    updateSavedTestPlan: vi.fn().mockResolvedValue({ ...plan, title: 'Plano de login' }),
    linkE2eTestSavedCase: vi.fn().mockResolvedValue(base),
    getE2eTest: vi.fn().mockResolvedValue(linked),
    getTestSuites: vi.fn().mockResolvedValue(suites),
    getAllSavedTestPlans: vi.fn().mockResolvedValue([plan]),
    rerunE2eTest: vi.fn().mockResolvedValue(undefined),
    reviseE2eTestCase: vi.fn(),
    ...overrides,
  };
}

/** The pieces as the test detail wires them: the edit button in the header, the section apart. */
function Harness({
  apiClient,
  test,
  isReadOnly,
  onChanged,
}: {
  apiClient: ApiClient;
  test: E2eTestDetail;
  isReadOnly: boolean;
  onChanged: (test: E2eTestDetail) => void;
}) {
  const saved = useSavedCaseLink(apiClient, test.id, test.savedCase, onChanged);
  return (
    <>
      <E2eEditSavedCase saved={saved} isReadOnly={isReadOnly} disabled={false} />
      <E2eLinkedSavedCase
        apiClient={apiClient}
        test={test}
        saved={saved}
        isReadOnly={isReadOnly}
        disabled={false}
      />
    </>
  );
}

function setup(
  test: E2eTestDetail,
  options: { client?: ReturnType<typeof makeClient>; isReadOnly?: boolean } = {},
) {
  const client = options.client ?? makeClient();
  const onChanged = vi.fn();
  const view = render(
    <Harness
      apiClient={client as unknown as ApiClient}
      test={test}
      isReadOnly={options.isReadOnly ?? false}
      onChanged={onChanged}
    />,
  );
  return { client, onChanged, view };
}

async function pick(root: ReturnType<typeof within>, label: string, option: string) {
  fireEvent.focus(root.getByRole('combobox', { name: label }));
  fireEvent.click(await within(document.body).findByRole('option', { name: option }));
}

afterEach(() => vi.restoreAllMocks());

describe('E2eLinkedSavedCase', () => {
  it('links the test to a case picked in a Test Plan, one case only', async () => {
    const { client, onChanged, view } = setup(base);
    expect(view.getByText('Nenhum test case do ADK vinculado.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Vincular test case do ADK' }));
    const picker = await view.findByTestId('e2e-saved-case-picker');
    const submit = () => view.getByRole('button', { name: 'Vincular' }) as HTMLButtonElement;
    // Nothing to link until a case is picked.
    expect(submit().disabled).toBe(true);
    await pick(within(picker), 'Test Plan', 'Checkout');
    expect(within(picker).queryByText(/Todos os casos/)).toBeNull();
    fireEvent.click(within(picker).getByLabelText(/Login/));
    fireEvent.click(within(picker).getByLabelText(/Outro/));
    expect(within(picker).getByLabelText<HTMLInputElement>(/Login/).checked).toBe(false);
    fireEvent.click(within(picker).getByLabelText(/Login/));
    // Changing the suite drops the pick.
    await pick(within(picker), 'Test Plan', 'Checkout');
    expect(submit().disabled).toBe(true);
    fireEvent.click(within(picker).getByLabelText(/Login/));
    fireEvent.submit(picker.closest('form')!);
    await waitFor(() =>
      expect(client.linkE2eTestSavedCase).toHaveBeenCalledWith('test-1', {
        planId: 'plan-1',
        caseId: 'c-1',
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(base);
    await waitFor(() => expect(view.queryByTestId('e2e-saved-case-picker')).toBeNull());
  });

  it('ignores a submit with nothing picked, cancels, and says why linking failed', async () => {
    const client = makeClient();
    const { onChanged, view } = setup(base, { client });
    fireEvent.click(view.getByRole('button', { name: 'Vincular test case do ADK' }));
    const picker = await view.findByTestId('e2e-saved-case-picker');
    fireEvent.submit(picker.closest('form')!);
    expect(client.linkE2eTestSavedCase).not.toHaveBeenCalled();

    await pick(within(picker), 'Test Plan', 'Checkout');
    fireEvent.click(within(picker).getByLabelText(/Login/));
    client.linkE2eTestSavedCase.mockRejectedValueOnce(new Error('Sem permissão'));
    fireEvent.click(view.getByRole('button', { name: 'Vincular' }));
    expect((await view.findByRole('alert')).textContent).toBe('Sem permissão');
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.getByText('Nenhum test case do ADK vinculado.')).toBeInTheDocument();
  });

  it('shows the linked case and edits it in its Test Plan, reading the test back', async () => {
    const { client, onChanged, view } = setup(linked);
    expect(await view.findByText('Plano de login')).toBeInTheDocument();
    expect(view.getByText('Login')).toBeInTheDocument();
    expect(client.getSavedTestPlan).toHaveBeenCalledWith('plan-1');

    fireEvent.click(view.getByRole('button', { name: 'Editar test case' }));
    expect(view.getByText('CT-02')).toBeInTheDocument();
    fireEvent.click(view.getByText('save-case'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(linked));
    expect(client.updateSavedTestPlan).toHaveBeenCalledWith('plan-1', {
      title: 'Plano de login',
      suiteId: 'suite-1',
      plans: [
        plan.plans[0],
        {
          title: 'Login v2',
          description: 'Valida o login',
          steps: [],
          metadata: plan.plans[1]!.metadata,
        },
      ],
    });
    expect(client.getE2eTest).toHaveBeenCalledWith('test-1');
    expect(view.queryByTestId('case-modal')).toBeNull();
  });

  it('keeps the case metadata, leaves out a missing suite and closes the editor', async () => {
    const client = makeClient({
      getSavedTestPlan: vi.fn().mockResolvedValue({ ...plan, suiteId: undefined }),
    });
    const { view } = setup(linked, { client });
    fireEvent.click(await view.findByRole('button', { name: 'Editar test case' }));
    fireEvent.click(view.getByText('close-case'));
    expect(view.queryByTestId('case-modal')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Editar test case' }));
    fireEvent.click(view.getByText('save-bare'));
    await waitFor(() => expect(client.updateSavedTestPlan).toHaveBeenCalled());
    const [, sent] = client.updateSavedTestPlan.mock.calls[0]!;
    expect(sent).not.toHaveProperty('suiteId');
    expect(sent.plans[1].metadata).toEqual(plan.plans[1]!.metadata);
  });

  it('says why saving the case failed and keeps the editor open', async () => {
    const client = makeClient();
    const { onChanged, view } = setup(linked, { client });
    fireEvent.click(await view.findByRole('button', { name: 'Editar test case' }));
    client.updateSavedTestPlan.mockRejectedValueOnce('offline');
    fireEvent.click(view.getByText('save-case'));
    expect((await view.findByRole('alert')).textContent).toBe(
      'Não foi possível atualizar o vínculo com o test case.',
    );
    expect(view.getByTestId('case-modal')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('talks to the AI about the test and hands its answer to the editor', async () => {
    fixResults.mockClear();
    const revision = { reply: 'Ajustei.', testCase: null };
    const client = makeClient({ reviseE2eTestCase: vi.fn().mockResolvedValue(revision) });
    const { view } = setup(linked, { client });
    fireEvent.click(await view.findByRole('button', { name: 'Editar test case' }));
    fireEvent.click(view.getByText('fix-ask'));
    await waitFor(() => expect(fixResults).toHaveBeenCalledWith(revision));
    expect(client.reviseE2eTestCase).toHaveBeenCalledWith('test-1', TURN);
  });

  it('saves the case the AI fixed and writes the script again from it alone', async () => {
    fixResults.mockClear();
    const client = makeClient({ rerunE2eTest: vi.fn().mockResolvedValue(undefined) });
    const { view, onChanged } = setup(linked, { client });
    fireEvent.click(await view.findByRole('button', { name: 'Editar test case' }));
    fireEvent.click(view.getByText('fix-regenerate'));
    await waitFor(() => expect(fixResults).toHaveBeenCalledWith('regenerated'));
    const [, saved] = client.updateSavedTestPlan.mock.calls[0]!;
    expect(saved.plans[1]).toMatchObject({ title: 'Login v3' });
    // The plan carried the case to the test before the script is rewritten, and not from the old one.
    expect(client.rerunE2eTest).toHaveBeenCalledWith('test-1', true, { useLastRun: false });
    expect(client.updateSavedTestPlan.mock.invocationCallOrder[0]).toBeLessThan(
      client.rerunE2eTest.mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(linked));
    expect(view.queryByTestId('case-modal')).toBeNull();
  });

  it('keeps the editor open with the reason when the case cannot be saved, and does not rewrite', async () => {
    fixResults.mockClear();
    const client = makeClient({
      updateSavedTestPlan: vi.fn().mockRejectedValue(new Error('plan is locked')),
      rerunE2eTest: vi.fn(),
    });
    const { view } = setup(linked, { client });
    fireEvent.click(await view.findByRole('button', { name: 'Editar test case' }));
    fireEvent.click(view.getByText('fix-regenerate'));
    await waitFor(() => expect(fixResults).toHaveBeenCalledWith('failed: plan is locked'));
    expect(client.rerunE2eTest).not.toHaveBeenCalled();
    expect(view.getByTestId('case-modal')).toBeInTheDocument();
  });

  it('says on the page why the script was not rewritten once the case is saved', async () => {
    fixResults.mockClear();
    const client = makeClient({
      rerunE2eTest: vi.fn().mockRejectedValue(new Error('Já em andamento')),
    });
    const { view } = setup(linked, { client });
    fireEvent.click(await view.findByRole('button', { name: 'Editar test case' }));
    fireEvent.click(view.getByText('fix-regenerate'));
    await waitFor(() => expect(fixResults).toHaveBeenCalledWith('regenerated'));
    expect(await view.findByRole('alert')).toHaveTextContent('Já em andamento');
    expect(client.updateSavedTestPlan).toHaveBeenCalled();
    expect(view.queryByTestId('case-modal')).toBeNull();
  });

  it('unlinks the test from its case', async () => {
    const { client, onChanged, view } = setup(linked);
    fireEvent.click(await view.findByRole('button', { name: 'Desvincular test case do ADK' }));
    await waitFor(() => expect(client.linkE2eTestSavedCase).toHaveBeenCalledWith('test-1', null));
    expect(onChanged).toHaveBeenCalledWith(base);
  });

  it('offers only the unlink when the case is gone, whether the plan or the case', async () => {
    const gone = makeClient({ getSavedTestPlan: vi.fn().mockRejectedValue(new Error('404')) });
    const first = setup(linked, { client: gone });
    expect(await first.view.findByRole('status')).toHaveTextContent(/não existe mais/);
    expect(first.view.queryByRole('button', { name: 'Editar test case' })).toBeNull();
    fireEvent.click(first.view.getByRole('button', { name: 'Desvincular test case do ADK' }));
    await waitFor(() => expect(gone.linkE2eTestSavedCase).toHaveBeenCalled());
    first.view.unmount();

    const removed = makeClient({
      getSavedTestPlan: vi.fn().mockResolvedValue({ ...plan, plans: [plan.plans[0]] }),
    });
    const second = setup(linked, { client: removed });
    expect(await second.view.findByRole('status')).toHaveTextContent(/não existe mais/);
    second.view.unmount();

    // A read-only viewer sees the warning and nothing to click.
    const third = setup(linked, { client: gone, isReadOnly: true });
    await third.view.findByRole('status');
    expect(third.view.queryByRole('button')).toBeNull();
  });

  it('is read only for viewers: no link, edit or unlink', async () => {
    const none = setup(base, { isReadOnly: true });
    expect(none.view.queryByRole('button')).toBeNull();
    none.view.unmount();
    const some = setup(linked, { isReadOnly: true });
    await some.view.findByText('Plano de login');
    expect(some.view.queryByRole('button', { name: /Editar|Desvincular/ })).toBeNull();
    expect(some.view.getByRole('tooltip')).toHaveTextContent(/acompanham o test case/);
  });

  it('needs access to Test Plans to link or edit a case, but not to unlink it', async () => {
    const access = {
      ...FULL_ACCESS,
      modules: { ...FULL_ACCESS.modules, testplans: 'view' as const },
    };
    const wrap = (test: E2eTestDetail) =>
      render(
        <PermissionsProvider access={access}>
          <Harness
            apiClient={makeClient() as unknown as ApiClient}
            test={test}
            isReadOnly={false}
            onChanged={vi.fn()}
          />
        </PermissionsProvider>,
      );
    const none = wrap(base);
    expect(none.queryByRole('button')).toBeNull();
    none.unmount();
    const some = wrap(linked);
    await some.findByText('Plano de login');
    expect(some.queryByRole('button', { name: 'Editar test case' })).toBeNull();
    expect(some.getByRole('button', { name: 'Desvincular test case do ADK' })).toBeInTheDocument();
  });

  it('shows a placeholder while the case loads and ignores a plan that arrives late', async () => {
    let resolve: (plan: SavedTestPlanDto) => void = () => undefined;
    const client = makeClient({
      getSavedTestPlan: vi.fn().mockReturnValue(new Promise((done) => (resolve = done))),
    });
    const { view } = setup(linked, { client });
    expect(view.queryByText('Login')).toBeNull();
    view.unmount();
    resolve(plan);
    const failing = makeClient({
      getSavedTestPlan: vi.fn().mockReturnValue(
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('late')), 0);
        }),
      ),
    });
    setup(linked, { client: failing }).view.unmount();
    await new Promise((done) => setTimeout(done, 5));
  });
});

describe('E2eSavedCasePicker for a single case', () => {
  const noop = () => undefined;
  it('keeps picking several cases when it is not single', async () => {
    const client = makeClient();
    const onPickCase = vi.fn();
    const view = render(
      <E2eSavedCasePicker
        apiClient={client as unknown as ApiClient}
        value={{ suiteId: '', planId: 'plan-1', caseIds: null }}
        onChange={noop}
        onPickCase={onPickCase}
      />,
    );
    const picker = await view.findByTestId('e2e-saved-case-picker');
    fireEvent.click(within(picker).getByLabelText(/Login/));
    expect(onPickCase).toHaveBeenCalledWith({ planId: 'plan-1', caseId: 'c-1' });
    expect(within(picker).getByText(/Todos os casos/)).toBeInTheDocument();
  });
});
