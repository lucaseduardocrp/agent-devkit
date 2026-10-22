import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient, type AuditHistoryPage } from '../src/lib/api-client.js';
import { WorkView, type WorkViewProps } from '../src/features/issues/WorkView.js';
import type {
  AgentRun,
  DashboardSummary,
  InboxItem,
  Issue,
  IssueComment,
} from '../src/features/issues/issue-types.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';

const NOW = new Date().toISOString();

/** A run executed while the inbox issue was assigned to the signed-in user. */
function inboxRun(createdAt = NOW): InboxItem['runs'][number] {
  return {
    id: 'run-1',
    agentId: 'agent-a',
    status: 'succeeded',
    attempt: 1,
    createdAt,
    finishedAt: createdAt,
  };
}

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
    createIssue: vi.spyOn(api, 'createIssue').mockResolvedValue(issues[0]!),
    updateIssue: vi.spyOn(api, 'updateIssue').mockResolvedValue(issues[0]!),
    deleteIssue: vi.spyOn(api, 'deleteIssue').mockResolvedValue(undefined),
    addIssueComment: vi
      .spyOn(api, 'addIssueComment')
      .mockResolvedValue({ comment: makeComment({ id: 'new-comment', body: 'Fresh note' }) }),
    startIssueRun: vi.spyOn(api, 'startIssueRun').mockResolvedValue(makeRun()),
    cancelAgentRun: vi.spyOn(api, 'cancelAgentRun').mockResolvedValue(makeRun()),
    getAuditHistory: vi
      .spyOn(api, 'getAuditHistory')
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 1 }),
  };
  return { api, spies };
}

function makeComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: 'comment-1',
    issueId: 'issue-1',
    authorId: 'user-a',
    body: 'Comment body',
    createdAt: NOW,
    ...overrides,
  };
}

function makeMember(userId: string, user?: { name: string; email: string }): WorkspaceMember {
  return {
    id: `member-${userId}`,
    workspaceId: 'ws',
    userId,
    role: 'MEMBER',
    permissions: {},
    createdAt: NOW,
    ...(user ? { user: { id: userId, ...user } } : {}),
  };
}

function renderView(api: ApiClient, props: Partial<WorkViewProps> = {}) {
  return render(
    <WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" {...props} />,
  );
}

async function openDetail(name = '1 Prepare release') {
  fireEvent.click(await screen.findByRole('button', { name }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() =>
    expect(
      within(dialog).queryAllByRole('status', { name: 'Carregando detalhes da issue...' }),
    ).toHaveLength(0),
  );
  return dialog;
}

async function waitIdle(element: HTMLElement) {
  await waitFor(() =>
    expect((element as HTMLButtonElement | HTMLSelectElement).disabled).toBe(false),
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DAY = 86_400_000;

describe('WorkView issue list and board', () => {
  const issues = [
    makeIssue({ id: 'i1', number: 1, title: 'Ship docs', status: 'done', updatedAt: NOW }),
    makeIssue({
      id: 'i2',
      number: 2,
      title: 'Fix build',
      status: 'blocked',
      priority: 'urgent',
      updatedAt: new Date(Date.now() - 3 * DAY).toISOString(),
    }),
    makeIssue({
      id: 'i3',
      number: 3,
      title: 'Write tests',
      status: 'in_progress',
      updatedAt: 'not-a-date',
    }),
    makeIssue({
      id: 'i4',
      number: 4,
      title: 'Plan sprint',
      status: 'todo',
      updatedAt: '2026-01-15T12:00:00.000Z',
    }),
  ];

  it('colors rows by status, formats dates, searches and filters by status', async () => {
    const { api } = createApi({ issues });
    renderView(api);

    const dot = (name: string) =>
      screen.getByRole('button', { name }).querySelector('span')!.className;
    await screen.findByRole('button', { name: '1 Ship docs' });
    expect(dot('1 Ship docs')).toContain('bg-emerald-500');
    expect(dot('2 Fix build')).toContain('bg-red-500');
    expect(dot('3 Write tests')).toContain('bg-blue-500');
    expect(dot('4 Plan sprint')).toContain('bg-neutral-500');
    expect(screen.getByText('há 3 dias')).toBeInTheDocument();
    expect(screen.getByText(/15 de jan/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar issues' }), {
      target: { value: 'BUILD' },
    });
    expect(screen.getByRole('button', { name: '2 Fix build' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 Ship docs' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar issues' }), {
      target: { value: '' },
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrar status' }), {
      target: { value: 'done' },
    });
    expect(screen.getByRole('button', { name: '1 Ship docs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 Fix build' })).not.toBeInTheDocument();
  });

  it('moves cards between board columns by drag and drop', async () => {
    const { api, spies } = createApi({ issues });
    renderView(api);
    await screen.findByRole('button', { name: '1 Ship docs' });
    fireEvent.click(screen.getByRole('button', { name: 'Quadro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lista' }));
    expect(screen.getByRole('button', { name: 'Lista' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Quadro' }));

    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
    };
    const card = screen.getByText('Ship docs').closest('[draggable]') as HTMLElement;
    expect(card).toHaveAttribute('draggable', 'true');
    expect(card).toHaveTextContent('Alta');
    const blockedColumn = screen.getByText('Fix build').closest('section') as HTMLElement;
    expect(blockedColumn).toHaveTextContent('Bloqueada1');

    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(blockedColumn, { dataTransfer });
    fireEvent.drop(blockedColumn, { dataTransfer });
    await waitFor(() =>
      expect(spies.updateIssue).toHaveBeenCalledWith('i1', { status: 'blocked' }),
    );

    store.clear();
    fireEvent.drop(blockedColumn, { dataTransfer });
    expect(spies.updateIssue).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Fix build'));
    await waitFor(() => expect(spies.getIssue).toHaveBeenCalledWith('i2'));
  });

  it('shows only the filtered column and an empty message on the board', async () => {
    const { api } = createApi({ issues });
    renderView(api);
    await screen.findByRole('button', { name: '1 Ship docs' });
    fireEvent.click(screen.getByRole('button', { name: 'Quadro' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrar status' }), {
      target: { value: 'cancelled' },
    });
    const board = screen.getByLabelText('Quadro', { selector: 'div' });
    expect(within(board).getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByText('Nenhuma issue encontrada.')).toBeInTheDocument();
  });

  it('does not move cards for read-only members', async () => {
    const { api, spies } = createApi({ issues });
    renderView(api, { isReadOnly: true });
    await screen.findByRole('button', { name: '1 Ship docs' });
    fireEvent.click(screen.getByRole('button', { name: 'Quadro' }));
    const card = screen.getByText('Ship docs').closest('[draggable]') as HTMLElement;
    expect(card).toHaveAttribute('draggable', 'false');
    const dataTransfer = { setData: vi.fn(), getData: () => 'i1' };
    fireEvent.drop(card.closest('section')!, { dataTransfer });
    expect(spies.updateIssue).not.toHaveBeenCalled();
  });

  it('refreshes the list on demand', async () => {
    const { api, spies } = createApi({ issues });
    renderView(api);
    await screen.findByRole('button', { name: '1 Ship docs' });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(spies.getIssues).toHaveBeenCalledTimes(2));
  });
});

describe('WorkView issue pagination', () => {
  it('pages the issue list and returns to the first page when the search changes', async () => {
    localStorage.clear();
    const { api } = createApi({
      issues: Array.from({ length: 30 }, (_, index) =>
        makeIssue({ id: `p${index + 1}`, number: index + 1, title: `Task ${index + 1}` }),
      ),
    });
    renderView(api);
    await screen.findByRole('button', { name: '1 Task 1' });
    expect(screen.getByText(/Exibindo 1–25 de 30/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '26 Task 26' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getByRole('button', { name: '26 Task 26' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 Task 1' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar issues' }), {
      target: { value: 'Task' },
    });
    expect(screen.getByRole('button', { name: '1 Task 1' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Issues por página' })).toBeInTheDocument();
  });
});

describe('WorkView inbox', () => {
  const inbox: InboxItem[] = [
    {
      issue: makeIssue({ id: 'a', number: 1, title: 'Alpha task', createdBy: 'user-a' }),
      runs: [inboxRun()],
      readAt: null,
      archivedAt: null,
    },
    {
      issue: makeIssue({
        id: 'b',
        number: 2,
        title: 'Beta task',
        createdBy: 'user-x',
        assigneeUserId: 'user-a',
      }),
      runs: [inboxRun()],
      readAt: NOW,
      archivedAt: NOW,
    },
    {
      issue: makeIssue({
        id: 'c',
        number: 3,
        title: 'Gamma task',
        createdBy: 'user-x',
        status: 'blocked',
        updatedAt: new Date(Date.now() - 30 * DAY).toISOString(),
      }),
      runs: [inboxRun(new Date(Date.now() - 30 * DAY).toISOString())],
      readAt: null,
      archivedAt: null,
    },
    {
      issue: makeIssue({
        id: 'd',
        number: 4,
        title: 'Delta task',
        createdBy: 'user-x',
        assigneeUserId: 'user-a',
      }),
      runs: [inboxRun()],
      readAt: NOW,
      archivedAt: null,
    },
  ];
  const visible = () =>
    ['1 Alpha task', '2 Beta task', '3 Gamma task', '4 Delta task'].filter((name) =>
      screen.queryByRole('button', { name }),
    );

  it('filters the inbox tabs, highlights unread items and archives or restores them', async () => {
    const { api, spies } = createApi({ inbox });
    renderView(api, { tab: 'inbox' });

    await screen.findByRole('button', { name: '1 Alpha task' });
    // The inbox is private: every item ran while assigned to the user, so Mine lists all
    // that are not archived.
    expect(visible()).toEqual(['1 Alpha task', '3 Gamma task', '4 Delta task']);
    expect(screen.getByTestId('inbox-runs-a')).toHaveTextContent('1 execução · Concluída');
    expect(screen.getByText('Alpha task')).toHaveClass('font-semibold');
    expect(screen.getByText('Delta task')).not.toHaveClass('font-semibold');
    const unreadTab = screen.getByRole('tab', { name: /Não lidas/ });
    expect(unreadTab).toHaveTextContent('Não lidas2');

    fireEvent.click(screen.getByRole('tab', { name: 'Recentes' }));
    expect(screen.getByRole('tab', { name: 'Recentes' })).toHaveAttribute('aria-selected', 'true');
    expect(visible()).toEqual(['1 Alpha task', '4 Delta task']);
    fireEvent.click(unreadTab);
    expect(visible()).toEqual(['1 Alpha task', '3 Gamma task']);
    fireEvent.click(screen.getByRole('tab', { name: 'Bloqueadas' }));
    expect(visible()).toEqual(['3 Gamma task']);
    fireEvent.click(screen.getByRole('tab', { name: 'Todas' }));
    expect(visible()).toEqual(['1 Alpha task', '2 Beta task', '3 Gamma task', '4 Delta task']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar issues' }), {
      target: { value: 'gamma' },
    });
    expect(visible()).toEqual(['3 Gamma task']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar issues' }), {
      target: { value: '' },
    });

    const betaRow = screen.getByRole('button', { name: '2 Beta task' }).parentElement!;
    fireEvent.click(within(betaRow).getByRole('button', { name: 'Restaurar' }));
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenCalledWith('b', { archived: false }),
    );
    const alphaRow = screen.getByRole('button', { name: '1 Alpha task' }).parentElement!;
    const archive = within(alphaRow).getByRole('button', { name: 'Arquivar' });
    await waitIdle(archive);
    fireEvent.click(archive);
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenCalledWith('a', { archived: true }),
    );
  });

  it('hides the unread badge when everything is read', async () => {
    const { api } = createApi({
      inbox: [{ issue: makeIssue(), runs: [inboxRun()], readAt: NOW, archivedAt: null }],
    });
    renderView(api, { tab: 'inbox' });
    await screen.findByRole('button', { name: '1 Prepare release' });
    expect(screen.getByRole('tab', { name: 'Não lidas' }).textContent).toBe('Não lidas');
  });
});

describe('WorkView issue composer', () => {
  const agents = [makeAgent('agent-a', 'Alpha')];
  const members = [
    makeMember('user-b', { name: 'Bruno', email: 'bruno@example.com' }),
    makeMember('user-c', { name: '', email: 'carla@example.com' }),
    makeMember('user-d'),
  ];

  it('creates an issue with every field and opens it', async () => {
    const onOpenIssues = vi.fn();
    const { api, spies } = createApi({ members, dashboard: makeDashboard({ agents }) });
    renderView(api, { onOpenIssues });
    await screen.findByRole('button', { name: '1 Prepare release' });

    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: 'carla@example.com' })).toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('option', { name: 'Bruno' })).toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'user-d' })).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título' }), {
      target: { value: '  New thing  ' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), {
      target: { value: 'Details' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'in_review' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Prioridade' }), {
      target: { value: 'urgent' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Agente' }), {
      target: { value: 'agent-a' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Responsável' }), {
      target: { value: 'user-b' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar issue' }));

    await waitFor(() =>
      expect(spies.createIssue).toHaveBeenCalledWith({
        title: 'New thing',
        description: 'Details',
        status: 'in_review',
        priority: 'urgent',
        assigneeAgentId: 'agent-a',
        assigneeUserId: 'user-b',
      }),
    );
    expect(onOpenIssues).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Prepare release' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Nova issue' })).not.toBeInTheDocument();
  });

  it('closes the composer with the close button, cancel and Escape', async () => {
    const { api } = createApi();
    renderView(api, { newIssueRequest: 1 });
    expect(await screen.findByRole('heading', { name: 'Nova issue' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('heading', { name: 'Nova issue' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('heading', { name: 'Nova issue' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Nova issue' })).not.toBeInTheDocument();
  });

  it('keeps the composer open and shows the error when creation fails', async () => {
    const { api, spies } = createApi();
    spies.createIssue.mockRejectedValueOnce(new Error('Title taken'));
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Título' }), {
      target: { value: 'Duplicate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar issue' }));
    expect(await screen.findByText('Title taken')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nova issue' })).toBeInTheDocument();
  });
});

describe('WorkView issue description', () => {
  it('sanitizes imported HTML: keeps safe links, drops unsafe attributes and tags', async () => {
    const description =
      '<p class="lead">Hello <a href="https://ok.example" onclick="steal()">safe</a> ' +
      '<a href="javascript:alert(1)">bad</a><img src="x.png"><font color="red">inner</font>' +
      '<iframe src="https://evil.example"></iframe></p>';
    const { api } = createApi({ issues: [makeIssue({ description })] });
    renderView(api);
    const dialog = await openDetail();

    const safe = within(dialog).getByText('safe');
    expect(safe).toHaveAttribute('href', 'https://ok.example');
    expect(safe.hasAttribute('onclick')).toBe(false);
    expect(within(dialog).getByText('bad').hasAttribute('href')).toBe(false);
    expect(within(dialog).getByText(/inner/).tagName).toBe('P');
    expect(within(dialog).getByText(/Hello/).hasAttribute('class')).toBe(false);
    expect(dialog.querySelector('img, font, iframe')).toBeNull();
  });

  it('decodes HTML that was escaped before being stored', async () => {
    const description = '&lt;p&gt;&lt;strong&gt;Escaped&lt;/strong&gt; body&lt;/p&gt;';
    const { api } = createApi({ issues: [makeIssue({ description })] });
    renderView(api);
    const dialog = await openDetail();
    expect(within(dialog).getByText('Escaped').tagName).toBe('STRONG');
  });

  it('strips tags when DOMParser is unavailable', async () => {
    const { api } = createApi({
      issues: [makeIssue({ description: '<p>Plain <b>bold</b> text</p>' })],
    });
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    vi.stubGlobal('DOMParser', undefined);
    const dialog = await openDetail();
    expect(within(dialog).getByText(/Plain\s+bold\s+text/)).toBeInTheDocument();
    expect(dialog.querySelector('b')).toBeNull();
  });

  it('shows a dash for an empty description', async () => {
    const { api } = createApi({ issues: [makeIssue({ description: '' })] });
    renderView(api);
    const dialog = await openDetail();
    expect(within(dialog).getByText('—')).toBeInTheDocument();
  });
});

describe('WorkView issue detail', () => {
  const agents = [makeAgent('agent-a', 'Alpha')];
  const members = [makeMember('user-b', { name: 'Bruno', email: 'bruno@example.com' })];

  it('updates status, priority, agent and assignee, including unknown assignees', async () => {
    const assigned = makeIssue({ assigneeAgentId: 'agent-a', assigneeUserId: 'ghost-user' });
    const { api, spies } = createApi({
      issues: [assigned],
      members,
      dashboard: makeDashboard({ agents }),
    });
    renderView(api);
    await waitFor(() => expect(spies.getWorkspaceMembers).toHaveBeenCalled());
    const dialog = await openDetail();
    expect(within(dialog).getByRole('option', { name: 'ghost-user' })).toBeInTheDocument();

    const change = async (name: string, value: string, expected: object) => {
      const select = within(dialog).getByRole('combobox', { name });
      await waitIdle(select);
      fireEvent.change(select, { target: { value } });
      await waitFor(() => expect(spies.updateIssue).toHaveBeenLastCalledWith('issue-1', expected));
    };
    await change('Status', 'done', { status: 'done' });
    await change('Prioridade', 'low', { priority: 'low' });
    await change('Agente', '', { assigneeAgentId: null });
    await change('Responsável', 'user-b', { assigneeUserId: 'user-b' });
    await change('Responsável', '', { assigneeUserId: null });
  });

  it('shows a generic save error when an update fails without an Error', async () => {
    const { api, spies } = createApi();
    spies.updateIssue.mockRejectedValueOnce('nope');
    renderView(api);
    const dialog = await openDetail();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'done' },
    });
    expect(await screen.findByText('Não foi possível salvar.')).toBeInTheDocument();
  });

  it('edits the title and description, and can cancel editing', async () => {
    const { api, spies } = createApi();
    renderView(api);
    const dialog = await openDetail();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título' }), {
      target: { value: ' Renamed ' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Descrição' }), {
      target: { value: 'New body' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(spies.updateIssue).toHaveBeenCalledWith('issue-1', {
        title: 'Renamed',
        description: 'New body',
      }),
    );
    const edit = await within(dialog).findByRole('button', { name: 'Editar' });

    fireEvent.click(edit);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(within(dialog).queryByRole('textbox', { name: 'Título' })).not.toBeInTheDocument();
    expect(spies.updateIssue).toHaveBeenCalledTimes(1);
  });

  it('shows skeletons while details load, then lists runs and cancels an active run', async () => {
    const assigned = makeIssue({ assigneeAgentId: 'agent-a' });
    const { api, spies } = createApi({ issues: [assigned] });
    const detail = deferred<{ issue: Issue; comments: IssueComment[] }>();
    spies.getIssue.mockReturnValueOnce(detail.promise);
    spies.getAgentRuns.mockResolvedValue([
      makeRun({
        id: 'run-1',
        attempt: 2,
        status: 'running',
        provider: 'openai',
        model: 'gpt-4',
        inputTokens: 10,
        outputTokens: 5,
        costMicros: 1_500_000,
      }),
      makeRun({ id: 'run-0', attempt: 1, status: 'failed', provider: 'anthropic', error: 'Boom' }),
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getAllByRole('status', { name: 'Carregando detalhes da issue...' }),
    ).toHaveLength(2);
    detail.resolve({ issue: assigned, comments: [] });

    expect(await within(dialog).findByText('#2 · Executando')).toBeInTheDocument();
    expect(within(dialog).getByText('openai / gpt-4 · 10 / 5 tokens')).toBeInTheDocument();
    expect(within(dialog).getByText(/US\$\s*1,50/)).toBeInTheDocument();
    expect(within(dialog).getByText('anthropic')).toBeInTheDocument();
    expect(within(dialog).getByText('Boom')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Executar agente' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar execução' }));
    await waitFor(() => expect(spies.cancelAgentRun).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(spies.getAgentRuns).toHaveBeenLastCalledWith('issue-1'));
    expect(spies.getAgentRuns).toHaveBeenCalledTimes(2);
  });

  it('starts a run and reloads the run list', async () => {
    const assigned = makeIssue({ assigneeAgentId: 'agent-a' });
    const { api, spies } = createApi({ issues: [assigned] });
    renderView(api);
    const dialog = await openDetail();
    expect(within(dialog).getByText('Nenhuma execução ainda.')).toBeInTheDocument();
    spies.getAgentRuns.mockResolvedValue([makeRun({ status: 'queued' })]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Executar agente' }));
    await waitFor(() => expect(spies.startIssueRun).toHaveBeenCalledWith('issue-1'));
    expect(await within(dialog).findByText('#1 · Na fila')).toBeInTheDocument();
  });

  it('labels comment authors and handles comment results and failures', async () => {
    const { api, spies } = createApi({ dashboard: makeDashboard({ agents }) });
    spies.getIssue.mockResolvedValue({
      issue: makeIssue(),
      comments: [
        makeComment({ id: 'c1', authorId: 'user-a', body: 'Mine body' }),
        makeComment({ id: 'c2', authorId: 'agent-a', body: 'Agent body' }),
        makeComment({ id: 'c3', authorId: 'abcdefgh-other', body: 'Other body' }),
      ],
    });
    renderView(api);
    const dialog = await openDetail();
    expect(await within(dialog).findByText('Mine body')).toBeInTheDocument();
    expect(within(dialog).getByText('Minhas')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Alpha')).toHaveLength(2);
    expect(within(dialog).getByText('abcdefgh')).toBeInTheDocument();

    const input = within(dialog).getByRole('textbox', { name: 'Escreva um comentário...' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(spies.addIssueComment).not.toHaveBeenCalled();

    spies.addIssueComment.mockResolvedValueOnce({
      comment: makeComment({ id: 'c4', body: 'Queued note' }),
      run: makeRun({ id: 'run-new', attempt: 3, status: 'queued' }),
      automationError: 'Agent offline',
    });
    fireEvent.change(input, { target: { value: ' Queued note ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar comentário' }));
    await waitFor(() =>
      expect(spies.addIssueComment).toHaveBeenCalledWith('issue-1', 'Queued note'),
    );
    expect(await within(dialog).findByText('Agent offline')).toBeInTheDocument();
    expect(within(dialog).getByText('#3 · Na fila')).toBeInTheDocument();
    expect(within(dialog).getByText('Queued note')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('');

    spies.addIssueComment.mockRejectedValueOnce(new Error('Comment failed'));
    fireEvent.change(input, { target: { value: 'Again' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar comentário' }));
    expect(await within(dialog).findByText('Comment failed')).toBeInTheDocument();

    spies.addIssueComment.mockRejectedValueOnce('offline');
    const submit = within(dialog).getByRole('button', { name: 'Adicionar comentário' });
    await waitIdle(submit);
    fireEvent.click(submit);
    expect(await within(dialog).findByText('Não foi possível salvar.')).toBeInTheDocument();
  });

  it('toggles read and archived state of the inbox item from the detail', async () => {
    const { api, spies } = createApi({
      inbox: [{ issue: makeIssue(), runs: [inboxRun()], readAt: null, archivedAt: NOW }],
    });
    renderView(api);
    const dialog = await openDetail();
    expect(spies.updateInboxItem).toHaveBeenCalledWith('issue-1', { read: true });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Marcar como não lida' }));
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenLastCalledWith('issue-1', { read: false }),
    );
    const markRead = await within(dialog).findByRole('button', { name: 'Marcar como lida' });
    await waitIdle(markRead);
    fireEvent.click(markRead);
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenLastCalledWith('issue-1', { read: true }),
    );
    const restore = within(dialog).getByRole('button', { name: 'Restaurar' });
    await waitIdle(restore);
    fireEvent.click(restore);
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenLastCalledWith('issue-1', { archived: false }),
    );
  });

  it('archives an already read inbox item without marking it read again', async () => {
    const { api, spies } = createApi({
      inbox: [{ issue: makeIssue(), runs: [inboxRun()], readAt: NOW, archivedAt: null }],
    });
    renderView(api);
    const dialog = await openDetail();
    expect(spies.updateInboxItem).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenCalledWith('issue-1', { archived: true }),
    );
  });

  it('keeps the issue when deletion is not confirmed', async () => {
    const { api, spies } = createApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderView(api);
    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(confirm).toHaveBeenCalledWith('Excluir esta issue?');
    expect(spies.deleteIssue).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the load error when the details cannot be fetched', async () => {
    const { api, spies } = createApi();
    spies.getIssue.mockRejectedValueOnce(new Error('Detail failed'));
    spies.getIssue.mockRejectedValueOnce('offline');
    renderView(api);
    await openDetail();
    expect(await screen.findByText('Detail failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    await openDetail();
    expect(await screen.findByText('Não foi possível carregar os dados.')).toBeInTheDocument();
  });

  it('resolves members, agents, statuses and priorities in the history', async () => {
    const { api, spies } = createApi({ members, dashboard: makeDashboard({ agents }) });
    const history: AuditHistoryPage = {
      total: 1,
      page: 1,
      totalPages: 1,
      items: [
        {
          id: 'event-1',
          entityType: 'issue',
          entityId: 'issue-1',
          action: 'update',
          actorId: 'user-a',
          actorName: 'Ana',
          requestId: 'req',
          operation: 'PATCH /issues',
          occurredAt: NOW,
          before: {
            assigneeUserId: 'user-b',
            assigneeAgentId: 'agent-a',
            status: 'done',
            priority: 'urgent',
            number: 3,
            note: 'free text',
          },
          after: {
            assigneeUserId: 'ghost-user',
            assigneeAgentId: 'ghost-agent',
            status: 'weird',
            priority: 'odd',
          },
        },
      ],
    };
    spies.getAuditHistory.mockResolvedValue(history);
    renderView(api);
    await waitFor(() => expect(spies.getWorkspaceMembers).toHaveBeenCalled());
    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(spies.getAuditHistory).toHaveBeenCalledWith(
        'issue',
        1,
        expect.any(AbortSignal),
        'issue-1',
      ),
    );
    const panel = document.querySelector('dialog[open]') as HTMLElement;
    await within(panel).findByText('Bruno');
    for (const text of [
      'Alpha',
      'Concluída',
      'Urgente',
      'ghost-user',
      'ghost-agent',
      'weird',
      'odd',
      '3',
      'free text',
    ])
      expect(within(panel).getByText(text)).toBeInTheDocument();
  });

  it('polls the open issue for comments and runs, ignoring failures and late answers', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { api, spies } = createApi();
    renderView(api);
    const dialog = await openDetail();
    const poll = setIntervalSpy.mock.calls.find(([, delay]) => delay === 5000)![0] as () => void;

    spies.getIssue.mockResolvedValueOnce({
      issue: makeIssue(),
      comments: [makeComment({ body: 'Polled comment' })],
    });
    spies.getAgentRuns.mockResolvedValueOnce([makeRun({ attempt: 4, status: 'succeeded' })]);
    await act(async () => poll());
    expect(await within(dialog).findByText('Polled comment')).toBeInTheDocument();
    expect(await within(dialog).findByText('#4 · Concluída')).toBeInTheDocument();
    expect(spies.getIssues).toHaveBeenCalledTimes(2);

    spies.getIssue.mockRejectedValueOnce(new Error('poll failed'));
    spies.getAgentRuns.mockRejectedValueOnce(new Error('poll failed'));
    await act(async () => poll());
    expect(within(dialog).getByText('Polled comment')).toBeInTheDocument();
    expect(screen.queryByText('poll failed')).not.toBeInTheDocument();

    const lateIssue = deferred<{ issue: Issue; comments: IssueComment[] }>();
    const lateRuns = deferred<readonly AgentRun[]>();
    spies.getIssue.mockReturnValueOnce(lateIssue.promise);
    spies.getAgentRuns.mockReturnValueOnce(lateRuns.promise);
    await act(async () => poll());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await act(async () => {
      lateIssue.resolve({ issue: makeIssue(), comments: [makeComment({ body: 'Too late' })] });
      lateRuns.resolve([]);
      await Promise.all([lateIssue.promise, lateRuns.promise]);
    });
    expect(screen.queryByText('Too late')).not.toBeInTheDocument();
  });
});
