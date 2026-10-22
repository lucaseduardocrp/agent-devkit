import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';
import { WorkView, type WorkViewProps } from '../src/features/issues/WorkView.js';
import type {
  AgentRun,
  CostSummary,
  DashboardSummary,
  InboxItem,
  Issue,
} from '../src/features/issues/issue-types.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';

const NOW = new Date().toISOString();

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    workspaceId: 'ws',
    number: 1,
    title: 'Prepare release',
    description: 'Finish the checklist',
    status: 'todo',
    priority: 'high',
    assigneeAgentId: null,
    assigneeUserId: null,
    createdBy: 'user-a',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAgent(id: string, name: string): CustomAgentDto {
  return {
    id,
    workspaceId: 'ws',
    name,
    slug: id,
    description: `${name} description`,
    instructions: '',
    role: 'CUSTOM',
    temperature: 0,
    isSystem: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    issueId: 'issue-1',
    agentId: 'agent-a',
    status: 'succeeded',
    mode: 'server',
    attempt: 1,
    output: null,
    error: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeDashboard(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    agents: [],
    recentIssues: [],
    recentActivity: [],
    totalIssues: 0,
    inProgress: 0,
    open: 0,
    byStatus: {
      backlog: 0,
      todo: 0,
      in_progress: 0,
      in_review: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    },
    byPriority: { urgent: 0, high: 0, medium: 0, low: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createApi(
  data: {
    issues?: Issue[];
    inbox?: InboxItem[];
    dashboard?: DashboardSummary;
    members?: WorkspaceMember[];
  } = {},
) {
  const api = new ApiClient();
  const issues = data.issues ?? [makeIssue()];
  const spies = {
    getIssues: vi.spyOn(api, 'getIssues').mockResolvedValue(issues),
    getInbox: vi.spyOn(api, 'getInbox').mockResolvedValue(data.inbox ?? []),
    getDashboard: vi
      .spyOn(api, 'getDashboard')
      .mockResolvedValue(data.dashboard ?? makeDashboard()),
    getWorkspaceMembers: vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue(data.members ?? []),
    getIssue: vi.spyOn(api, 'getIssue').mockImplementation(async (id: string) => ({
      issue: issues.find((issue) => issue.id === id) ?? issues[0]!,
      comments: [],
    })),
    getAgentRuns: vi.spyOn(api, 'getAgentRuns').mockResolvedValue([]),
    updateInboxItem: vi.spyOn(api, 'updateInboxItem').mockResolvedValue(undefined),
    setMonthlyBudget: vi
      .spyOn(api, 'setMonthlyBudget')
      .mockResolvedValue({} as unknown as CostSummary),
    setCostRate: vi.spyOn(api, 'setCostRate').mockImplementation(async (rate) => rate),
    deleteCostRate: vi.spyOn(api, 'deleteCostRate').mockResolvedValue(undefined),
  };
  return { api, spies };
}

function renderView(api: ApiClient, props: Partial<WorkViewProps> = {}) {
  return render(
    <WorkView apiClient={api} workspaceId="ws" tab="dashboard" currentUserId="user-a" {...props} />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkView dashboard', () => {
  it('shows agents with their live issue and spend, cost rates and recent runs', async () => {
    const live = makeIssue({
      id: 'issue-live',
      number: 7,
      title: 'Live task',
      status: 'in_progress',
      assigneeAgentId: 'agent-a',
    });
    const { api, spies } = createApi({
      issues: [live],
      dashboard: makeDashboard({
        agents: [makeAgent('agent-a', 'Alpha'), makeAgent('agent-b', 'Beta')],
        activeRuns: 3,
        inProgress: 1,
        open: 4,
        costs: {
          monthSpendMicros: 2_000_000,
          monthlyBudgetMicros: 0,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalTokens: 15,
          unpricedRuns: 2,
          rates: [
            { provider: 'openai', model: 'gpt', inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          ],
          byAgent: { 'agent-a': { spendMicros: 500_000, runs: 1, unpricedRuns: 0 } },
        },
        recentRuns: [
          makeRun({ id: 'r1', agentId: 'agent-a', status: 'succeeded', costMicros: 250_000 }),
          makeRun({ id: 'r2', agentId: 'zzzzzzzz-unknown', status: 'failed', costMicros: null }),
        ],
      }),
    });
    renderView(api, { canManageCosts: true });

    const agents = await screen.findByRole('region', { name: 'Agentes' });
    const [alpha, beta] = within(agents).getAllByRole('article');
    expect(alpha).toHaveTextContent('AL');
    expect(alpha).toHaveTextContent('Issue atual');
    expect(alpha).toHaveTextContent(/Gasto do mês: US\$\s*0,50/);
    expect(beta).toHaveTextContent('Sem issue em andamento');
    expect(beta).not.toHaveTextContent('Gasto do mês');
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2 execuções sem tarifa')).toBeInTheDocument();
    expect(screen.getByText(/openai \/ gpt: \$1 Entrada, \$2 Saída/)).toBeInTheDocument();
    expect(screen.getByText('Alpha · Concluída')).toBeInTheDocument();
    expect(screen.getByText('zzzzzzzz · Falhou')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Ainda não há atividade.')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma issue encontrada.')).toBeInTheDocument();

    fireEvent.click(within(alpha!).getByRole('button', { name: '#7 · Live task' }));
    expect(await screen.findByRole('heading', { name: 'Live task' })).toBeInTheDocument();
    expect(spies.getIssue).toHaveBeenCalledWith('issue-live');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Live task' })).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Excluir openai gpt' }));
    await waitFor(() => expect(spies.deleteCostRate).toHaveBeenCalledWith('openai', 'gpt'));

    const provider = screen.getByRole('textbox', { name: 'Provedor' }) as HTMLInputElement;
    await waitFor(() => expect(provider.disabled).toBe(false));
    fireEvent.change(provider, { target: { value: ' anthropic ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Modelo' }), {
      target: { value: ' claude ' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Entrada' }), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Saída' }), {
      target: { value: '15' },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Salvar tarifa' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Salvar tarifa' }));
    await waitFor(() =>
      expect(spies.setCostRate).toHaveBeenCalledWith({
        provider: 'anthropic',
        model: 'claude',
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      }),
    );
    await waitFor(() => expect(provider.value).toBe(''));

    const refreshes = spies.getDashboard.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(spies.getDashboard.mock.calls.length).toBe(refreshes + 1));
  });

  it('opens issues from recent activity and recent issues and formats their dates', async () => {
    const today = makeIssue({ id: 'today', number: 1, title: 'Today issue', updatedAt: NOW });
    const older = makeIssue({
      id: 'older',
      number: 2,
      title: 'Older issue',
      updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    const { api, spies } = createApi({
      issues: [today, older],
      dashboard: makeDashboard({ recentActivity: [today, older], recentIssues: [older] }),
    });
    renderView(api);

    expect(await screen.findAllByText('há 3 dias')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /#1 Today issue/ }));
    expect(await screen.findByRole('heading', { name: 'Today issue' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    fireEvent.click(screen.getByRole('button', { name: '2 Older issue' }));
    await waitFor(() => expect(spies.getIssue).toHaveBeenCalledWith('older'));
  });

  it('falls back to zero tokens when the cost summary omits the token totals', async () => {
    const { api } = createApi({
      dashboard: makeDashboard({
        agents: [makeAgent('agent-a', 'Alpha')],
        inProgress: 5,
        costs: {
          monthSpendMicros: 0,
          monthlyBudgetMicros: 0,
          unpricedRuns: 0,
          rates: [],
          byAgent: {},
        } as unknown as DashboardSummary['costs'],
      }),
    });
    renderView(api);

    expect(await screen.findByText('Tarefas em andamento')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Total de tokens usados: 0')).toBeInTheDocument();
    expect(screen.getByText('Entrada / saída: 0 / 0')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: /Orçamento mensal/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Provedor' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).not.toHaveTextContent('Gasto do mês');
  });

  it('shows skeleton cards while the dashboard loads', () => {
    const { api, spies } = createApi();
    spies.getDashboard.mockReturnValue(new Promise(() => undefined));
    spies.getWorkspaceMembers.mockReturnValue(new Promise(() => undefined));
    renderView(api);
    expect(screen.getAllByTestId('skeleton-card')).toHaveLength(3);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('reports budget failures with the server message or a generic message', async () => {
    const { api, spies } = createApi({
      dashboard: makeDashboard({
        costs: {
          monthSpendMicros: 0,
          monthlyBudgetMicros: 2_500_000,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          unpricedRuns: 0,
          rates: [],
          byAgent: {},
        },
      }),
    });
    spies.setMonthlyBudget.mockRejectedValueOnce(new Error('Budget too high'));
    spies.setMonthlyBudget.mockRejectedValueOnce('offline');
    renderView(api, { canManageCosts: true });

    const budget = (await screen.findByRole('spinbutton', {
      name: /Orçamento mensal/,
    })) as HTMLInputElement;
    expect(budget.value).toBe('2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Budget too high');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível salvar.'),
    );
  });
});

describe('WorkView loading lifecycle', () => {
  it('ignores results that arrive after the view is unmounted', async () => {
    const { api, spies } = createApi();
    const issues = deferred<readonly Issue[]>();
    spies.getIssues.mockReturnValueOnce(issues.promise);
    const view = renderView(api, { tab: 'issues' });
    view.unmount();
    issues.resolve([makeIssue()]);
    await issues.promise;
    expect(spies.getIssues.mock.calls[0]![0]?.aborted).toBe(true);
  });

  it('ignores failures that arrive after the view is unmounted', async () => {
    const { api, spies } = createApi();
    const issues = deferred<readonly Issue[]>();
    spies.getIssues.mockReturnValueOnce(issues.promise);
    const view = renderView(api, { tab: 'issues' });
    view.unmount();
    issues.reject(new Error('late failure'));
    await expect(issues.promise).rejects.toThrow('late failure');
    expect(spies.getIssues.mock.calls[0]![0]?.aborted).toBe(true);
  });

  it('shows a generic load error when the failure is not an Error', async () => {
    const { api, spies } = createApi();
    spies.getIssues.mockRejectedValueOnce('down');
    renderView(api, { tab: 'issues' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar os dados.',
    );
  });

  it('does not request anything without a workspace', async () => {
    const { api, spies } = createApi();
    renderView(api, { tab: 'issues', workspaceId: null });
    expect(await screen.findByText('Nenhuma issue encontrada.')).toBeInTheDocument();
    expect(spies.getIssues).not.toHaveBeenCalled();
    expect(spies.getWorkspaceMembers).not.toHaveBeenCalled();
  });

  it('keeps working when members cannot be loaded and ignores members after unmount', async () => {
    const first = createApi();
    first.spies.getWorkspaceMembers.mockRejectedValueOnce(new Error('forbidden'));
    const view = renderView(first.api, { tab: 'issues' });
    expect(await screen.findByRole('button', { name: '1 Prepare release' })).toBeInTheDocument();
    expect(first.spies.getWorkspaceMembers).toHaveBeenCalledWith('ws');
    view.unmount();

    const second = createApi();
    const members = deferred<readonly WorkspaceMember[]>();
    second.spies.getWorkspaceMembers.mockReturnValueOnce(members.promise);
    const late = renderView(second.api, { tab: 'issues' });
    await waitFor(() => expect(second.spies.getWorkspaceMembers).toHaveBeenCalled());
    late.unmount();
    members.resolve([]);
    await members.promise;
  });

  it('reports the unread inbox count', async () => {
    const onInboxCountChange = vi.fn();
    const { api } = createApi({
      inbox: [
        { issue: makeIssue({ id: 'a' }), runs: [], readAt: null, archivedAt: null },
        { issue: makeIssue({ id: 'b' }), runs: [], readAt: NOW, archivedAt: null },
        { issue: makeIssue({ id: 'c' }), runs: [], readAt: null, archivedAt: NOW },
      ],
    });
    renderView(api, { tab: 'inbox', onInboxCountChange });
    await waitFor(() => expect(onInboxCountChange).toHaveBeenLastCalledWith(1));
  });
});
