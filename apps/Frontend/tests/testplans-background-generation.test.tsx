import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityCenter, ActivityProvider } from '../src/features/activities/ActivityCenter.js';
import { TestPlansView } from '../src/features/testplans/TestPlansView.js';
import type { ExploreContextSelection } from '../src/features/e2e/E2eExploreContext.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { GenerateTestPlanResponse, SavedTestPlanDto } from '../src/lib/api-client.js';

// A stand-in for the real picker: one button that picks a PBI.
vi.mock('../src/features/e2e/E2eExploreContext.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  E2eExploreContext: ({ onChange }: { onChange: (value: ExploreContextSelection) => void }) => (
    <button type="button" onClick={() => onChange({ pbi: ['pbi-1'], brain: [], issue: [] })}>
      pick context
    </button>
  ),
}));

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
    plans: [{ title: 'Pay with card', description: 'Pay', steps: [] }],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function client(plans: readonly SavedTestPlanDto[] = []) {
  const api = new ApiClient();
  vi.spyOn(api, 'getSavedTestPlans').mockResolvedValue({
    items: [...plans],
    page: 1,
    pageSize: 8,
    total: plans.length,
    totalPages: 1,
  });
  vi.spyOn(api, 'getAllSavedTestPlans').mockResolvedValue([...plans]);
  vi.spyOn(api, 'getTestSuites').mockResolvedValue([]);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function generated(saved: SavedTestPlanDto): GenerateTestPlanResponse {
  return { plans: saved.plans, csv: 'csv', savedPlan: saved };
}

function mount(api: ApiClient, initialTab: 'create' | 'saved' = 'create') {
  return render(
    <ActivityProvider>
      <ActivityCenter />
      <TestPlansView
        apiClient={api}
        initialTab={initialTab}
        activeWorkspaceId="ws-1"
        workspaces={WORKSPACES}
      />
    </ActivityProvider>,
  );
}

const typeStory = (text: string) =>
  fireEvent.change(screen.getByLabelText('User story / requisito'), { target: { value: text } });

afterEach(() => vi.restoreAllMocks());

describe('Test Plan generation in the background', () => {
  it('frees the form at once, tells where it ends, and shows the plan when it is done', async () => {
    const api = client();
    const pending = deferred<GenerateTestPlanResponse>();
    vi.spyOn(api, 'generateTestPlan').mockReturnValue(pending.promise);
    mount(api);

    typeStory('Pay   with\ncard  '.padEnd(120, 'x'));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));

    // The button stays usable, the text is gone, and the person is told they can leave.
    expect(screen.getByRole('button', { name: 'Gerar testes' })).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('User story / requisito')).toHaveProperty('value', '');
    expect(screen.getByTestId('test-plan-skeleton')).toHaveTextContent(/segundo plano/i);
    // The Activity Center names which generation it is, shortened to one line.
    fireEvent.click(screen.getByRole('button', { name: /atividades/i }));
    expect(
      await screen.findByText(/^Plano de testes: Pay with card x+\.\.\.$/),
    ).toBeInTheDocument();

    await act(async () => pending.resolve(generated(plan({ id: 'plan-9', title: 'Generated' }))));
    expect(await screen.findByTestId('test-result')).toBeInTheDocument();
    expect(screen.queryByTestId('test-plan-skeleton')).not.toBeInTheDocument();
  });

  it('lets the generation end after the screen is gone, and the notification still arrives', async () => {
    const api = client();
    const pending = deferred<GenerateTestPlanResponse>();
    const generate = vi.spyOn(api, 'generateTestPlan').mockReturnValue(pending.promise);
    const ui = mount(api);

    typeStory('Checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));
    expect(generate).toHaveBeenCalledOnce();

    // The person goes to another screen: only the Activity Center is left.
    ui.rerender(
      <ActivityProvider>
        <ActivityCenter />
      </ActivityProvider>,
    );
    expect(screen.queryByLabelText('User story / requisito')).not.toBeInTheDocument();
    expect(generate.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it('notifies a failure and gives back what was typed, including the chosen context', async () => {
    const api = client();
    vi.spyOn(api, 'generateTestPlan').mockRejectedValue(new Error('Generator down'));
    mount(api);

    typeStory('Checkout');
    fireEvent.change(screen.getByLabelText('Critérios de aceite (opcional)'), {
      target: { value: 'Must pay' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'pick context' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));

    expect(await screen.findAllByText('Generator down')).not.toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByLabelText('User story / requisito')).toHaveProperty('value', 'Checkout'),
    );
    expect(screen.getByLabelText('Critérios de aceite (opcional)')).toHaveProperty(
      'value',
      'Must pay',
    );
    expect(screen.queryByTestId('test-plan-skeleton')).not.toBeInTheDocument();
  });

  it('keeps what was typed meanwhile when a failure arrives later', async () => {
    const api = client();
    const pending = deferred<GenerateTestPlanResponse>();
    vi.spyOn(api, 'generateTestPlan').mockReturnValue(pending.promise);
    mount(api);

    typeStory('First');
    fireEvent.change(screen.getByLabelText('Critérios de aceite (opcional)'), {
      target: { value: 'First criteria' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));
    // The next requirement is already being written when the first one fails.
    typeStory('Second');
    fireEvent.change(screen.getByLabelText('Critérios de aceite (opcional)'), {
      target: { value: 'Second criteria' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'pick context' }));

    await act(async () => pending.reject(new Error('Generator down')));
    expect(await screen.findAllByText('Generator down')).not.toHaveLength(0);
    expect(screen.getByLabelText('User story / requisito')).toHaveProperty('value', 'Second');
    expect(screen.getByLabelText('Critérios de aceite (opcional)')).toHaveProperty(
      'value',
      'Second criteria',
    );
  });

  it('does not replace the plan the person has open with one that finishes later', async () => {
    const opened = plan({ id: 'plan-open', title: 'Opened plan' });
    const api = client([opened]);
    const pending = deferred<GenerateTestPlanResponse>();
    vi.spyOn(api, 'generateTestPlan').mockReturnValue(pending.promise);
    mount(api);

    typeStory('Checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Gerar testes' }));
    // Meanwhile a saved plan is opened.
    fireEvent.click(screen.getByTestId('btn-view-saved-plans'));
    fireEvent.click(await screen.findByText('Opened plan'));
    await screen.findByTestId('saved-plan-detail');

    await act(async () => pending.resolve(generated(plan({ id: 'plan-new', title: 'Late plan' }))));
    // The one that was open is still the one shown, and the create tab has no result of its own.
    expect(screen.getByTestId('saved-plan-detail')).toHaveTextContent('Opened plan');
    expect(screen.getByTestId('saved-plan-detail')).not.toHaveTextContent('Late plan');
    expect(screen.queryByTestId('test-plan-skeleton')).not.toBeInTheDocument();
  });
});
