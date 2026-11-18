import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';
import { MediaProvider } from '../src/features/shared/media.js';
import { WorkView, type WorkViewProps } from '../src/features/issues/WorkView.js';
import type {
  AgentRun,
  DashboardSummary,
  InboxItem,
  Issue,
} from '../src/features/issues/issue-types.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';

const NOW = new Date().toISOString();

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
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
});

const makeRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
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
});

const makeMember = (userId: string, name: string): WorkspaceMember => ({
  id: `member-${userId}`,
  workspaceId: 'ws',
  userId,
  role: 'MEMBER',
  permissions: {},
  createdAt: NOW,
  user: { id: userId, name, email: `${userId}@example.com` },
});

const emptyDashboard = (agents: CustomAgentDto[] = []): DashboardSummary => ({
  agents: agents as never,
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
});

function createApi(
  data: {
    issues?: Issue[];
    inbox?: InboxItem[];
    members?: WorkspaceMember[];
    runs?: AgentRun[];
    agents?: CustomAgentDto[];
  } = {},
) {
  const api = new ApiClient();
  const issues = data.issues ?? [makeIssue()];
  const spies = {
    getIssues: vi.spyOn(api, 'getIssues').mockResolvedValue(issues),
    getInbox: vi.spyOn(api, 'getInbox').mockResolvedValue(data.inbox ?? []),
    getDashboard: vi.spyOn(api, 'getDashboard').mockResolvedValue(emptyDashboard(data.agents)),
    getWorkspaceMembers: vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue(data.members ?? []),
    getIssue: vi.spyOn(api, 'getIssue').mockImplementation(async (id: string) => ({
      issue: issues.find((issue) => issue.id === id) ?? issues[0]!,
      comments: [],
    })),
    getAgentRuns: vi.spyOn(api, 'getAgentRuns').mockResolvedValue(data.runs ?? []),
    updateInboxItem: vi.spyOn(api, 'updateInboxItem').mockResolvedValue(undefined),
    createIssue: vi.spyOn(api, 'createIssue').mockResolvedValue(issues[0]!),
    updateIssue: vi.spyOn(api, 'updateIssue').mockResolvedValue(issues[0]!),
    continueAgentRun: vi.spyOn(api, 'continueAgentRun').mockResolvedValue(makeRun()),
    getAuditHistory: vi
      .spyOn(api, 'getAuditHistory')
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 1 }),
  };
  return { api, spies };
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

const openFilters = () => {
  const toggle = screen.getByRole('button', { name: /^(Filters|Filtros)/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function addImage(scope: HTMLElement) {
  const input = scope.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] },
    });
  });
}

describe('WorkView inline images', () => {
  it('places an attached image in the description of a new issue', async () => {
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    const dialog = screen.getByRole('dialog');
    await addImage(dialog);
    const description = within(dialog).getByRole('textbox', {
      name: /^Descrição/,
    }) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inserir no texto: shot.png' }));
    expect(description.value).toMatch(/^!\[.*\]\(.+\)\n$/);

    fireEvent.change(description, { target: { value: 'Intro' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inserir no texto: shot.png' }));
    expect(description.value).toMatch(/^Intro\n\n!\[/);
  });

  it('chooses a type for a new issue', async () => {
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título' }), {
      target: { value: 'Typed' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Tipo' }), {
      target: { value: 'bug' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar issue' }));
    await waitFor(() =>
      expect(api.createIssue).toHaveBeenCalledWith(expect.objectContaining({ type: 'bug' })),
    );
  });

  it('places an attached image in the description while editing an issue', async () => {
    const { api } = createApi();
    renderView(api);
    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    await addImage(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inserir no texto: shot.png' }));
    const description = within(dialog).getByRole('textbox', {
      name: /^Descrição/,
    }) as HTMLTextAreaElement;
    expect(description.value).toMatch(/^Finish the checklist\n\n!\[/);
  });
});

describe('WorkView issue sidebar', () => {
  it('sets the type and the proofreader, keeping a proofreader that left the workspace', async () => {
    const members = [makeMember('user-b', 'Bruno')];
    const { api, spies } = createApi({
      members,
      issues: [makeIssue({ proofreaderUserId: 'user-gone' })],
    });
    renderView(api);
    const dialog = await openDetail();
    await waitFor(() =>
      expect(within(dialog).getAllByRole('option', { name: 'Bruno' }).length).toBe(2),
    );
    expect(within(dialog).getByRole('option', { name: 'user-gone' })).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Revisor' }), {
      target: { value: 'user-b' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Tipo' }), {
      target: { value: 'task' },
    });
    fireEvent.click(
      within(dialog)
        .getAllByRole('button', { name: 'Salvar' })
        .find((button) => !button.hasAttribute('disabled'))!,
    );
    await waitFor(() =>
      expect(spies.updateIssue).toHaveBeenCalledWith('issue-1', {
        proofreaderUserId: 'user-b',
        type: 'task',
      }),
    );

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Revisor' }), {
      target: { value: '' },
    });
    expect(within(dialog).getByRole('combobox', { name: 'Revisor' })).toHaveProperty('value', '');
  });
});

describe('WorkView focus from another module', () => {
  it('opens the issue it is sent to once, and ignores other requests', async () => {
    const issues = [makeIssue(), makeIssue({ id: 'issue-2', number: 2, title: 'Second' })];
    const { api, spies } = createApi({ issues });
    const onFocusHandled = vi.fn();
    const view = renderView(api, {
      focus: { kind: 'pbi', ref: 'issue-2', nonce: 1 },
      onFocusHandled,
    });
    await screen.findByRole('button', { name: '2 Second' });
    expect(spies.getIssue).not.toHaveBeenCalled();

    view.rerender(
      <WorkView
        apiClient={api}
        workspaceId="ws"
        tab="issues"
        currentUserId="user-a"
        focus={{ kind: 'issue', ref: 'missing', nonce: 2 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(spies.getIssue).not.toHaveBeenCalled();

    view.rerender(
      <WorkView
        apiClient={api}
        workspaceId="ws"
        tab="issues"
        currentUserId="user-a"
        focus={{ kind: 'issue', ref: 'issue-2', nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    await waitFor(() => expect(spies.getIssue).toHaveBeenCalledWith('issue-2'));
    expect(onFocusHandled).toHaveBeenCalledTimes(1);

    // The same request again does not reopen the issue.
    fireEvent.keyDown(document, { key: 'Escape' });
    view.rerender(
      <WorkView
        apiClient={api}
        workspaceId="ws"
        tab="issues"
        currentUserId="user-a"
        focus={{ kind: 'issue', ref: 'issue-2', nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />,
    );
    expect(spies.getIssue).toHaveBeenCalledTimes(1);
  });

  it('opens it without a handler to tell', async () => {
    const { api, spies } = createApi();
    renderView(api, { focus: { kind: 'issue', ref: 'issue-1', nonce: 1 } });
    await waitFor(() => expect(spies.getIssue).toHaveBeenCalledWith('issue-1'));
  });
});

describe('WorkView saved filters', () => {
  const stored = (name: string, id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    query: '',
    status: '',
    priority: '',
    assignee: '',
    agent: '',
    iteration: '',
    ...extra,
  });
  const key = 'adk:issue-saved-filters:ws';

  it('lists stored filters, ignoring malformed entries, and applies, replaces and deletes them', async () => {
    localStorage.setItem(
      key,
      JSON.stringify([
        stored('Urgent', 'f1', { priority: 'urgent' }),
        stored('Todo', 'f2', { status: 'todo' }),
        null,
        'text',
        { id: 'broken', name: 'Broken' },
      ]),
    );
    const { api } = createApi({
      issues: [
        makeIssue(),
        makeIssue({ id: 'issue-2', number: 2, title: 'Rush', priority: 'urgent' }),
      ],
    });
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    openFilters();
    const select = screen.getByRole('combobox', { name: 'Filtros salvos' });
    expect(within(select).queryByRole('option', { name: 'Broken' })).toBeNull();

    fireEvent.change(select, { target: { value: 'f1' } });
    expect(screen.queryByRole('button', { name: '1 Prepare release' })).toBeNull();
    expect(screen.getByRole('button', { name: '2 Rush' })).toBeInTheDocument();

    // An empty choice does not change the filters.
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.queryByRole('button', { name: '1 Prepare release' })).toBeNull();

    // Saving under the same name replaces the stored filter.
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    const name = screen.getByRole('textbox', { name: 'Nome do filtro' });
    expect((name as HTMLInputElement).value).toBe('Urgent');
    fireEvent.change(name, { target: { value: ' urgent ' } });
    fireEvent.submit(name.closest('form')!);
    expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(4 - 2);

    // A blank name is not saved.
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    const blank = screen.getByRole('textbox', { name: 'Nome do filtro' });
    fireEvent.change(blank, { target: { value: '   ' } });
    fireEvent.submit(blank.closest('form')!);
    expect(screen.getByRole('textbox', { name: 'Nome do filtro' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir filtro salvo: urgent' }));
    expect(JSON.parse(localStorage.getItem(key)!).map((entry: { id: string }) => entry.id)).toEqual(
      ['f2'],
    );
  });

  it('starts empty when the stored value is not a list or cannot be read', async () => {
    localStorage.setItem(key, JSON.stringify({ id: 'f1' }));
    const first = createApi();
    const view = renderView(first.api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    openFilters();
    expect(
      within(screen.getByRole('combobox', { name: 'Filtros salvos' })).queryAllByRole('option'),
    ).toHaveLength(1);
    view.unmount();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const second = createApi();
    renderView(second.api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    openFilters();
    expect(
      within(screen.getByRole('combobox', { name: 'Filtros salvos' })).queryAllByRole('option'),
    ).toHaveLength(1);
  });

  it('keeps a saved filter in memory when the storage refuses it', async () => {
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    openFilters();
    fireEvent.change(screen.getByRole('combobox', { name: 'Prioridade' }), {
      target: { value: 'high' },
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    const name = screen.getByRole('textbox', { name: 'Nome do filtro' });
    fireEvent.change(name, { target: { value: 'High' } });
    fireEvent.submit(name.closest('form')!);
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument();
  });
});

describe('WorkView board cards', () => {
  it('shows the type and assignee on a card and clears the drop target on leaving', async () => {
    const issues = [
      makeIssue({ id: 'i1', title: 'Typed card', type: 'bug', assigneeUserId: 'user-b' }),
      makeIssue({ id: 'i2', number: 2, title: 'Other', status: 'blocked' }),
    ];
    const { api } = createApi({ issues, members: [makeMember('user-b', 'Bruno')] });
    renderView(api);
    await screen.findByRole('button', { name: '1 Typed card' });
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    const card = screen.getByText('Typed card').closest('article') as HTMLElement;
    await waitFor(() => expect(card).toHaveTextContent('Bruno'));
    expect(card).toHaveTextContent('Bug');

    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: '',
    };
    const column = screen.getByText('Other').closest('section') as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    expect(column).toHaveTextContent('#1 Typed card');
    // Moving inside the column keeps the target; leaving it clears the placeholder.
    const inside = createEvent.dragLeave(column);
    Object.defineProperty(inside, 'relatedTarget', { value: column.querySelector('h3') });
    fireEvent(column, inside);
    expect(column).toHaveTextContent('#1 Typed card');
    fireEvent.dragLeave(column, { relatedTarget: null });
    expect(column).not.toHaveTextContent('#1 Typed card');
    fireEvent.dragEnd(card);
    expect(card.className).not.toContain('opacity-50');
  });
});

describe('WorkView language', () => {
  it('counts the runs of an inbox item in English and Portuguese', async () => {
    const item = (id: string, runs: number): InboxItem => ({
      issue: makeIssue({ id, number: runs, title: `Issue ${runs}` }),
      runs: Array.from({ length: runs }, (_, index) => ({
        id: `${id}-run-${index}`,
        agentId: 'agent-a',
        status: 'succeeded' as const,
        attempt: index + 1,
        createdAt: NOW,
        finishedAt: NOW,
      })),
      readAt: null,
      archivedAt: null,
    });
    const { api } = createApi({ inbox: [item('a', 1), item('b', 3)] });
    renderView(api, { tab: 'inbox' });
    await screen.findByRole('button', { name: /Issue 1/ });
    expect(screen.getByText(/1 execução/)).toBeInTheDocument();
    expect(screen.getByText(/3 execuções/)).toBeInTheDocument();
  });
});

describe('WorkView workflow runs', () => {
  const steps = [
    { id: 's1', name: 'Draft' },
    { id: 's2', name: 'Review' },
    { id: 's3', name: 'Publish' },
  ];
  const state = (over: Record<string, unknown>) => ({
    autonomy: 'supervised' as const,
    steps,
    currentStepIndex: 1,
    results: [
      { stepId: 's1', name: 'Draft', output: 'ok', kind: 'result' as const },
      { stepId: 's2', name: 'Review', output: 'q', kind: 'question' as const },
    ],
    ...over,
  });

  it('shows the progress of the steps of a running workflow', async () => {
    const { api } = createApi({
      runs: [
        makeRun({
          status: 'running',
          provider: 'openai',
          model: 'gpt',
          inputTokens: 5,
          outputTokens: 7,
          workflowState: state({}),
        }),
        makeRun({
          id: 'run-2',
          status: 'succeeded',
          output: 'Done **well**',
          error: 'Late warning',
          provider: 'openai',
          workflowState: state({ currentStepIndex: 3 }),
        }),
      ],
    });
    renderView(api);
    const dialog = await openDetail();
    await waitFor(() => expect(within(dialog).getByText('Etapa 2 de 3')).toBeInTheDocument());
    expect(within(dialog).getAllByText('Draft')).toHaveLength(2);
    expect(within(dialog).getByText('5 / 7 tokens', { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText('Aprovar resultado final')).toBeInTheDocument();
    expect(within(dialog).getByText('Late warning')).toBeInTheDocument();
  });

  it('approves or revises a step waiting for review', async () => {
    const { api, spies } = createApi({
      runs: [makeRun({ status: 'waiting_review', workflowState: state({}) })],
    });
    renderView(api);
    const dialog = await openDetail();
    const approve = await within(dialog).findByRole('button', { name: 'Aprovar e continuar' });
    fireEvent.click(approve);
    await waitFor(() =>
      expect(spies.continueAgentRun).toHaveBeenCalledWith('run-1', { action: 'approve' }),
    );

    const revise = within(dialog).getByRole('button', { name: 'Pedir ajuste' });
    expect((revise as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByPlaceholderText('Descreva o ajuste necessário...'), {
      target: { value: ' Shorter ' },
    });
    fireEvent.click(revise);
    await waitFor(() =>
      expect(spies.continueAgentRun).toHaveBeenCalledWith('run-1', {
        action: 'revise',
        answer: 'Shorter',
      }),
    );
  });

  it('approves the final result when no step is left', async () => {
    const { api } = createApi({
      runs: [makeRun({ status: 'waiting_review', workflowState: null })],
    });
    renderView(api);
    const dialog = await openDetail();
    expect(
      await within(dialog).findByRole('button', { name: 'Aprovar resultado final' }),
    ).toBeInTheDocument();
  });

  it('answers a question the agent paused on', async () => {
    const { api, spies } = createApi({
      runs: [
        makeRun({
          status: 'waiting_input',
          workflowState: state({ question: 'Which branch?' }),
        }),
      ],
    });
    renderView(api);
    const dialog = await openDetail();
    expect(await within(dialog).findByText('Which branch?')).toBeInTheDocument();
    const answer = within(dialog).getByPlaceholderText(
      'Escreva sua resposta para continuar esta etapa...',
    );
    const form = answer.closest('form')!;
    // An empty answer is not sent.
    fireEvent.submit(form);
    expect(spies.continueAgentRun).not.toHaveBeenCalled();
    fireEvent.change(answer, { target: { value: ' main ' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() =>
      expect(spies.continueAgentRun).toHaveBeenCalledWith('run-1', {
        action: 'answer',
        answer: 'main',
      }),
    );
  });
});

const briefFor = (issueId: string) => ({
  issueId,
  workspaceId: 'ws',
  engineVersion: 1,
  generatedAt: '2026-11-05T12:00:00.000Z',
  updatedAt: '2026-11-05T12:00:00.000Z',
  source: 'engine',
  locked: [],
  complexity: { score: 3, level: 'small', signals: [] },
  recommendation: {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    effort: 'low',
    rationale: 'Small change.',
    estimatedCostUsd: null,
    alternatives: [],
  },
  readFirst: [{ kind: 'brain', label: 'Page', ref: 'page-1', reason: 'r' }],
  considerations: [],
  prompt: { system: 's', task: 't', outputFormat: 'o' },
  budget: { maxInputTokens: 1, maxOutputTokens: 1 },
});

describe('WorkView descriptions and pasted images', () => {
  const paste = (box: HTMLElement) =>
    fireEvent.paste(box, {
      clipboardData: { files: [new File(['png'], 'pasted.png', { type: 'image/png' })] },
    });

  it('writes an image pasted in the description of a new issue and of an edited one', async () => {
    const { api } = createApi();
    render(
      <MediaProvider apiClient={api}>
        <WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" />
      </MediaProvider>,
    );
    await screen.findByRole('button', { name: '1 Prepare release' });
    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    const composer = screen.getByRole('dialog');
    const box = within(composer).getByRole('textbox', {
      name: /^Descrição/,
    }) as HTMLTextAreaElement;
    paste(box);
    await waitFor(() => expect(box.value).toContain('![pasted.png]('));
    fireEvent.keyDown(document, { key: 'Escape' });

    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    const edit = within(dialog).getByRole('textbox', { name: /^Descrição/ }) as HTMLTextAreaElement;
    paste(edit);
    await waitFor(() => expect(edit.value).toContain('![pasted.png]('));
  });

  it('keeps the safe parts of an image in an imported description', async () => {
    const description =
      '<p>Look <img alt="chart" title="Q3" src="https://files.example.com/chart.png" ' +
      'onerror="x()"></p>';
    const { api } = createApi({ issues: [makeIssue({ description })] });
    renderView(api);
    const dialog = await openDetail();
    const image = dialog.querySelector('img')!;
    expect(image.getAttribute('alt')).toBe('chart');
    expect(image.getAttribute('title')).toBe('Q3');
    expect(image.hasAttribute('onerror')).toBe(false);
  });
});

describe('WorkView saving details', () => {
  const editTitle = async () => {
    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    return dialog;
  };
  const submitDetails = (dialog: HTMLElement) =>
    fireEvent.submit(within(dialog).getByRole('textbox', { name: 'Título' }).closest('form')!);

  it('sends nothing when the details form has no change, nor an empty title', async () => {
    const { api, spies } = createApi();
    renderView(api);
    const dialog = await editTitle();
    submitDetails(dialog);
    expect(spies.updateIssue).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título' }), {
      target: { value: '   ' },
    });
    submitDetails(dialog);
    expect(spies.updateIssue).not.toHaveBeenCalled();
  });

  it('shows the message of the error when the update fails', async () => {
    const { api, spies } = createApi();
    spies.updateIssue.mockRejectedValueOnce(new Error('Title is locked'));
    renderView(api);
    const dialog = await editTitle();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título' }), {
      target: { value: 'New title' },
    });
    submitDetails(dialog);
    expect(await screen.findByText('Title is locked')).toBeInTheDocument();
  });
});

describe('WorkView lists', () => {
  it('shows an empty inbox', async () => {
    const { api } = createApi({ inbox: [] });
    renderView(api, { tab: 'inbox' });
    expect(
      await screen.findByText(
        'Nenhuma execução foi feita enquanto uma issue estava atribuída a você.',
      ),
    ).toBeInTheDocument();
  });

  it('dates an inbox item by its latest activity and marks only the opened one as read', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    const run = (id: string, createdAt: string) => ({
      id,
      agentId: 'x',
      status: 'succeeded' as const,
      attempt: 1,
      createdAt,
      finishedAt: createdAt,
    });
    const inbox: InboxItem[] = [
      {
        issue: makeIssue({ id: 'a', number: 1, title: 'No runs', updatedAt: NOW }),
        runs: [],
        readAt: null,
        archivedAt: null,
      },
      {
        issue: makeIssue({ id: 'b', number: 2, title: 'Old run', updatedAt: NOW }),
        runs: [run('r', old)],
        readAt: null,
        archivedAt: null,
      },
      {
        issue: makeIssue({ id: 'c', number: 3, title: 'New run', updatedAt: old }),
        runs: [run('r2', NOW)],
        readAt: null,
        archivedAt: null,
      },
    ];
    const { api, spies } = createApi({ inbox, issues: inbox.map((item) => item.issue) });
    renderView(api, { tab: 'inbox' });
    fireEvent.click(await screen.findByRole('button', { name: /Old run/ }));
    await waitFor(() => expect(spies.updateInboxItem).toHaveBeenCalledWith('b', { read: true }));
    expect(spies.updateInboxItem).toHaveBeenCalledTimes(1);
  });

  it('ignores a stored draft move of a card that is not in the list', async () => {
    localStorage.setItem(
      'adk:kanban-draft:issues:ws',
      JSON.stringify({
        ghost: { from: 'todo', to: 'done' },
        'issue-1': { from: 'todo', to: 'done' },
      }),
    );
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    expect(screen.queryByText('ghost')).toBeNull();
  });

  it('filters by assignee and resolves the iteration through the PBI hierarchy', async () => {
    const issues = [
      makeIssue({
        id: 'i1',
        number: 1,
        title: 'In cycle',
        pbiItemId: 'p-a',
        assigneeUserId: 'user-b',
      }),
      makeIssue({ id: 'i2', number: 2, title: 'No iteration', pbiItemId: 'p-c' }),
      makeIssue({ id: 'i3', number: 3, title: 'Orphan PBI', pbiItemId: 'p-d' }),
      makeIssue({ id: 'i4', number: 4, title: 'Plain issue' }),
      makeIssue({ id: 'i5', number: 5, title: 'Root without iteration', pbiItemId: 'p-e' }),
    ];
    const { api } = createApi({ issues, members: [makeMember('user-b', 'Bruno')] });
    vi.spyOn(api, 'getPbiItems').mockResolvedValue([
      { id: 'p-a', parentId: 'p-b', sourceData: {} },
      { id: 'p-b', parentId: 'p-a', sourceData: {} },
      { id: 'p-c', parentId: null, sourceData: { iterationPath: 'Sprint 1' } },
      { id: 'p-d', parentId: 'p-gone', sourceData: {} },
      { id: 'p-e', parentId: null, sourceData: {} },
    ] as never);
    renderView(api);
    await screen.findByRole('button', { name: '1 In cycle' });
    openFilters();
    await screen.findByRole('option', { name: 'Sprint 1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), {
      target: { value: 'Sprint 1' },
    });
    expect(screen.getByRole('button', { name: '2 No iteration' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 In cycle' })).toBeNull();
    expect(screen.queryByRole('button', { name: '3 Orphan PBI' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), { target: { value: '' } });

    await screen.findByRole('option', { name: 'Bruno' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Agente' }), {
      target: { value: 'none' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Responsável' }), {
      target: { value: 'user-b' },
    });
    expect(screen.getByRole('button', { name: '1 In cycle' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '4 Plain issue' })).toBeNull();
  });
});

describe('WorkView board states', () => {
  const dataTransfer = () => {
    const store = new Map<string, string>();
    return {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: '',
    };
  };

  it('shows a card whose assignee is not a known member, and a card being saved', async () => {
    const issues = [
      makeIssue({ id: 'i1', title: 'Moving', assigneeUserId: 'user-gone' }),
      makeIssue({ id: 'i2', number: 2, title: 'Target', status: 'blocked' }),
    ];
    const { api, spies } = createApi({ issues });
    let finish: () => void = () => undefined;
    spies.updateIssue.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve(issues[0]!))),
    );
    renderView(api);
    await screen.findByRole('button', { name: '1 Moving' });
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    const card = screen.getByText('Moving').closest('article') as HTMLElement;
    expect(card).not.toHaveTextContent('user-gone');

    const transfer = dataTransfer();
    const column = screen.getByText('Target').closest('section') as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer: transfer });
    fireEvent.dragOver(column, { dataTransfer: transfer });
    // Leaving another column does not clear the column being hovered.
    fireEvent.dragLeave(card.closest('section')!, { relatedTarget: null });
    fireEvent.drop(column, { dataTransfer: transfer });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar agora' }));
    expect(await screen.findByRole('status', { name: 'Salvando movimento' })).toBeInTheDocument();
    finish();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Salvando movimento' })).toBeNull(),
    );
  });
});

describe('WorkView agent information', () => {
  it('goes to the module of a reference the agent reads first', async () => {
    const { api } = createApi();
    vi.spyOn(api, 'getIssueBrief').mockResolvedValue(briefFor('issue-1') as never);
    vi.spyOn(api, 'getKnowledgeDocuments').mockResolvedValue([
      { pageId: 'page-1', title: 'Page', content: 'Body' },
    ] as never);
    const onOpenReference = vi.fn();
    renderView(api, { onOpenReference });
    const dialog = await openDetail();
    fireEvent.click(await within(dialog).findByRole('tab', { name: 'Informações do Agente' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Abrir 1' }));
    const viewer = await screen.findAllByRole('dialog');
    fireEvent.click(
      await within(viewer[viewer.length - 1]!).findByRole('button', { name: 'Abrir no módulo' }),
    );
    expect(onOpenReference).toHaveBeenCalledWith(expect.objectContaining({ ref: 'page-1' }));
  });
});

describe('WorkView in English', () => {
  it('counts the runs of an inbox item', async () => {
    const run = (id: string) => ({
      id,
      agentId: 'x',
      status: 'succeeded' as const,
      attempt: 1,
      createdAt: NOW,
      finishedAt: NOW,
    });
    const item: InboxItem = {
      issue: makeIssue({ title: 'One run' }),
      runs: [run('r1')],
      readAt: null,
      archivedAt: null,
    };
    const two: InboxItem = {
      issue: makeIssue({ id: 'issue-2', number: 2, title: 'Two runs' }),
      runs: [run('r2'), run('r3')],
      readAt: null,
      archivedAt: null,
    };
    const { api } = createApi({ inbox: [item, two] });
    render(
      <I18nProvider initialLocale="en-US">
        <WorkView apiClient={api} workspaceId="ws" tab="inbox" currentUserId="user-a" />
      </I18nProvider>,
    );
    expect(await screen.findByText(/1 run ·/)).toBeInTheDocument();
    expect(screen.getByText(/2 runs ·/)).toBeInTheDocument();
  });
});
