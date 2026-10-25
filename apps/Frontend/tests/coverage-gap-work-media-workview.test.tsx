import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkView, type WorkViewProps } from '../src/features/issues/WorkView.js';
import type { AgentRun, InboxItem, Issue } from '../src/features/issues/issue-types.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';
import { MediaProvider, discardDrafts } from '../src/features/shared/media.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const NOW = new Date().toISOString();
const DAY = 86_400_000;
const DRAFT = /!\[shot\.png\]\(\/attachments\/drafts\/[0-9a-f-]+\)/;
const png = () => new File(['png'], 'shot.png', { type: 'image/png' });
const expectValue = (element: HTMLElement, value: string) =>
  expect((element as HTMLInputElement).value).toBe(value);

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

function inboxRun(createdAt = NOW): InboxItem['runs'][number] {
  return {
    id: `run-${createdAt}`,
    agentId: 'agent-a',
    status: 'succeeded',
    attempt: 1,
    createdAt,
    finishedAt: createdAt,
  };
}

function createApi(data: { issues?: Issue[]; inbox?: InboxItem[]; pbis?: PbiItem[] } = {}) {
  const api = new ApiClient();
  const issues = data.issues ?? [makeIssue()];
  const spies = {
    getIssues: vi.spyOn(api, 'getIssues').mockResolvedValue(issues),
    getInbox: vi.spyOn(api, 'getInbox').mockResolvedValue(data.inbox ?? []),
    getDashboard: vi.spyOn(api, 'getDashboard').mockResolvedValue({
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
    }),
    getWorkspaceMembers: vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue([]),
    getPbiItems: vi.spyOn(api, 'getPbiItems').mockResolvedValue(data.pbis ?? []),
    getIssue: vi.spyOn(api, 'getIssue').mockImplementation(async (id: string) => ({
      issue: issues.find((issue) => issue.id === id) ?? issues[0]!,
      comments: [],
    })),
    getAgentRuns: vi.spyOn(api, 'getAgentRuns').mockResolvedValue([]),
    updateInboxItem: vi.spyOn(api, 'updateInboxItem').mockResolvedValue(undefined),
    updateIssue: vi.spyOn(api, 'updateIssue').mockResolvedValue(issues[0]!),
    continueAgentRun: vi.spyOn(api, 'continueAgentRun').mockResolvedValue(makeRun()),
    getAuditHistory: vi
      .spyOn(api, 'getAuditHistory')
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 1 }),
  };
  return { api, spies };
}

function renderView(
  api: ApiClient,
  props: Partial<WorkViewProps> = {},
  wrap: (node: ReactNode) => ReactNode = (node) => node,
) {
  return render(
    wrap(
      <WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" {...props} />,
    ),
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

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkView images in descriptions', () => {
  it('keeps safe images with their alt and title in imported HTML', async () => {
    const description =
      '<p>Tela</p><img src="https://cdn.example.com/a.png" alt="Captura" title="Erro" onerror="x()">';
    const { api } = createApi({ issues: [makeIssue({ description })] });
    renderView(api);
    const dialog = await openDetail();
    const image = within(dialog).getByRole('img', { name: 'Captura' });
    expect(image).toHaveAttribute('title', 'Erro');
    expect(image.hasAttribute('onerror')).toBe(false);
  });

  it('writes pasted and attached images into the new issue description', async () => {
    const { api } = createApi();
    renderView(api, {}, (node) => <MediaProvider apiClient={api}>{node}</MediaProvider>);
    await screen.findByRole('button', { name: '1 Prepare release' });
    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    const dialog = screen.getByRole('dialog');
    const description = within(dialog).getByRole('textbox', { name: 'Descrição' });
    expect(
      within(dialog).getByText('Cole ou arraste imagens para colocá-las no texto.'),
    ).toBeInTheDocument();

    fireEvent.paste(description, { clipboardData: { files: [png()] } });
    expect((description as HTMLTextAreaElement).value).toMatch(DRAFT);

    fireEvent.change(description, { target: { value: '' } });
    fireEvent.change(dialog.querySelector('input[type="file"]')!, {
      target: { files: [png()] },
    });
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Inserir no texto: shot.png' }),
    );
    expect((description as HTMLTextAreaElement).value).toMatch(new RegExp(`^${DRAFT.source}\\n$`));

    fireEvent.change(description, { target: { value: 'Intro  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inserir no texto: shot.png' }));
    expect((description as HTMLTextAreaElement).value).toMatch(
      new RegExp(`^Intro\\n\\n${DRAFT.source}\\n$`),
    );
    discardDrafts((description as HTMLTextAreaElement).value);
  });

  it('writes pasted and attached images into the edited description', async () => {
    const { api } = createApi();
    renderView(api, {}, (node) => <MediaProvider apiClient={api}>{node}</MediaProvider>);
    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar' }));
    const description = within(dialog).getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Descrição',
    });
    description.setSelectionRange(description.value.length, description.value.length);
    fireEvent.drop(description, { dataTransfer: { files: [png()] } });
    expect(description.value).toMatch(new RegExp(`^Finish the checklist\\n\\n${DRAFT.source}`));

    fireEvent.change(dialog.querySelector('input[type="file"]')!, {
      target: { files: [png()] },
    });
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Inserir no texto: shot.png' }),
    );
    expect(description.value.match(new RegExp(DRAFT.source, 'g'))).toHaveLength(2);
    discardDrafts(description.value);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  });
});

describe('WorkView saved filters', () => {
  const saved = (id: string, name: string, extra: Record<string, string> = {}) => ({
    id,
    name,
    query: '',
    status: '',
    assignee: '',
    agent: '',
    priority: '',
    iteration: '',
    ...extra,
  });

  it('ignores stored filters that are not a list or not readable', async () => {
    localStorage.setItem('adk:issue-saved-filters:ws', '{}');
    const { api } = createApi();
    const first = renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    expect(
      within(screen.getByRole('combobox', { name: 'Filtros salvos' })).getAllByRole('option'),
    ).toHaveLength(1);
    first.unmount();

    localStorage.setItem('adk:issue-saved-filters:ws', '{not json');
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    expect(
      within(screen.getByRole('combobox', { name: 'Filtros salvos' })).getAllByRole('option'),
    ).toHaveLength(1);
  });

  it('applies, overwrites, sorts and deletes saved filters', async () => {
    localStorage.setItem(
      'adk:issue-saved-filters:ws',
      JSON.stringify([
        saved('f-urgent', 'Urgentes', { priority: 'urgent' }),
        saved('f-high', 'Altas', { priority: 'high' }),
        { id: 'broken' },
        null,
      ]),
    );
    const issues = [
      makeIssue(),
      makeIssue({ id: 'issue-2', number: 2, title: 'Fix build', priority: 'urgent' }),
    ];
    const { api } = createApi({ issues });
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    const select = screen.getByRole('combobox', { name: 'Filtros salvos' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Filtros salvos', 'Urgentes', 'Altas']);

    // An empty choice changes nothing.
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByRole('button', { name: '2 Fix build' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'f-urgent' } });
    expect(screen.queryByRole('button', { name: '1 Prepare release' })).toBeNull();

    // Saving an active filter suggests its name and overwrites it.
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    const name = screen.getByRole('textbox', { name: 'Nome do filtro' });
    expectValue(name, 'Urgentes');
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.submit(name.closest('form')!);
    expect(screen.getByRole('textbox', { name: 'Nome do filtro' })).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'urgentes' } });
    fireEvent.submit(name.closest('form')!);
    const stored = JSON.parse(localStorage.getItem('adk:issue-saved-filters:ws')!);
    expect(stored.map((entry: { id: string; name: string }) => [entry.id, entry.name])).toEqual([
      ['f-high', 'Altas'],
      ['f-urgent', 'urgentes'],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Excluir filtro salvo: urgentes' }));
    expect(JSON.parse(localStorage.getItem('adk:issue-saved-filters:ws')!)).toHaveLength(1);
    expect(screen.queryByRole('option', { name: 'urgentes' })).toBeNull();
  });

  it('keeps saved filters for the session when storage refuses them', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Prioridade' }), {
      target: { value: 'low' },
    });
    expect(screen.queryByRole('button', { name: '1 Prepare release' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    expectValue(screen.getByRole('textbox', { name: 'Nome do filtro' }), '');
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do filtro' }), {
      target: { value: 'Baixas' },
    });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Nome do filtro' }).closest('form')!);
    expect(screen.getByRole('option', { name: 'Baixas' })).toHaveProperty('selected', true);
  });

  it('filters by agent and assignee, with or without one', async () => {
    const issues = [
      makeIssue(),
      makeIssue({
        id: 'issue-2',
        number: 2,
        title: 'Agent work',
        assigneeAgentId: 'agent-a',
        assigneeUserId: 'user-b',
      }),
    ];
    const { api, spies } = createApi({ issues });
    spies.getWorkspaceMembers.mockResolvedValue([
      {
        id: 'member-b',
        workspaceId: 'ws',
        userId: 'user-b',
        role: 'MEMBER',
        permissions: {},
        createdAt: NOW,
        user: { id: 'user-b', name: 'Bruno', email: 'bruno@example.com' },
      },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: '1 Prepare release' });
    await screen.findByRole('option', { name: 'Bruno' });
    const assignee = screen.getByRole('combobox', { name: 'Responsável' });
    fireEvent.change(assignee, { target: { value: 'user-b' } });
    expect(screen.queryByRole('button', { name: '1 Prepare release' })).toBeNull();
    expect(screen.getByRole('button', { name: '2 Agent work' })).toBeInTheDocument();
    fireEvent.change(assignee, { target: { value: '' } });
    const agent = screen.getByRole('combobox', { name: 'Agente' });
    fireEvent.change(agent, { target: { value: 'none' } });
    expect(screen.queryByRole('button', { name: '2 Agent work' })).toBeNull();
    fireEvent.change(agent, { target: { value: '' } });
    expect(screen.getByRole('button', { name: '2 Agent work' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Prioridade' }), {
      target: { value: 'high' },
    });
    expect(screen.getByRole('button', { name: '1 Prepare release' })).toBeInTheDocument();
  });

  it('resolves iterations through missing and circular PBI parents', async () => {
    const pbi = (id: string, parentId: string | null, iterationPath?: string) =>
      ({ id, parentId, sourceData: iterationPath ? { iterationPath } : {} }) as unknown as PbiItem;
    const issues = [
      makeIssue({ pbiItemId: 'orphan' }),
      makeIssue({ id: 'issue-2', number: 2, title: 'Loop', pbiItemId: 'loop-a' }),
      makeIssue({ id: 'issue-3', number: 3, title: 'Root', pbiItemId: 'root' }),
      makeIssue({ id: 'issue-4', number: 4, title: 'Sprint', pbiItemId: 'sprint' }),
    ];
    const { api } = createApi({
      issues,
      pbis: [
        pbi('orphan', 'gone'),
        pbi('loop-a', 'loop-b'),
        pbi('loop-b', 'loop-a'),
        pbi('root', null),
        pbi('sprint', null, 'Proj\\Sprint 1'),
      ],
    });
    renderView(api);
    const iteration = await screen.findByRole('combobox', { name: 'Iteração' });
    expect(
      within(iteration)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([expect.any(String), 'Proj\\Sprint 1']);
    fireEvent.change(iteration, { target: { value: 'Proj\\Sprint 1' } });
    expect(screen.getByRole('button', { name: '4 Sprint' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 Loop' })).toBeNull();
  });
});

describe('WorkView inbox activity', () => {
  it('counts runs, dates items by their latest change and marks only the opened one as read', async () => {
    const inbox: InboxItem[] = [
      {
        issue: makeIssue({ title: 'Alpha task' }),
        runs: [inboxRun(), inboxRun(new Date(Date.now() - DAY).toISOString())],
        readAt: null,
        archivedAt: null,
      },
      {
        issue: makeIssue({ id: 'b', number: 2, title: 'Beta task' }),
        runs: [inboxRun(new Date(Date.now() - 40 * DAY).toISOString())],
        readAt: null,
        archivedAt: null,
      },
      {
        issue: makeIssue({ id: 'c', number: 3, title: 'Gamma task' }),
        runs: [],
        readAt: null,
        archivedAt: null,
      },
    ];
    const { api, spies } = createApi({ inbox, issues: inbox.map((item) => item.issue) });
    renderView(api, { tab: 'inbox' });
    expect(await screen.findByTestId('inbox-runs-issue-1')).toHaveTextContent('2 execuções');
    expect(screen.queryByTestId('inbox-runs-c')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Recentes' }));
    expect(screen.getByRole('button', { name: '2 Beta task' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Todas' }));
    await openDetail('1 Alpha task');
    await waitFor(() =>
      expect(spies.updateInboxItem).toHaveBeenCalledWith('issue-1', { read: true }),
    );
    expect(spies.updateInboxItem).toHaveBeenCalledTimes(1);
  });

  it('labels runs in English and explains an empty inbox', async () => {
    const inbox: InboxItem[] = [
      {
        issue: makeIssue({ updatedAt: new Date(Date.now() - 2 * DAY).toISOString() }),
        runs: [inboxRun(), inboxRun(new Date(Date.now() - DAY).toISOString())],
        readAt: NOW,
        archivedAt: null,
      },
      {
        issue: makeIssue({ id: 'single', number: 2, title: 'Single run' }),
        runs: [inboxRun()],
        readAt: NOW,
        archivedAt: null,
      },
    ];
    const { api } = createApi({ inbox });
    const view = renderView(api, { tab: 'inbox' }, (node) => (
      <I18nProvider initialLocale="en-US">{node}</I18nProvider>
    ));
    expect(await screen.findByTestId('inbox-runs-issue-1')).toHaveTextContent('2 runs');
    expect(screen.getByTestId('inbox-runs-single')).toHaveTextContent('1 run');
    view.unmount();

    renderView(createApi().api, { tab: 'inbox' });
    expect(
      await screen.findByText(
        'Nenhuma execução foi feita enquanto uma issue estava atribuída a você.',
      ),
    ).toBeInTheDocument();
  });
});

describe('WorkView workflow runs', () => {
  const steps = [
    { id: 's1', name: 'Analisar' },
    { id: 's2', name: 'Implementar' },
    { id: 's3', name: 'Revisar' },
  ];

  async function openRuns(runs: AgentRun[], props: Partial<WorkViewProps> = {}) {
    const { api, spies } = createApi({ issues: [makeIssue({ assigneeAgentId: 'agent-a' })] });
    spies.getAgentRuns.mockResolvedValue(runs);
    renderView(api, props);
    const dialog = await openDetail();
    return { dialog, spies };
  }

  const stepIcon = (dialog: HTMLElement, name: string) =>
    within(dialog).getByText(name).previousElementSibling!.className;

  it('shows step progress and approves or revises a step under review', async () => {
    const { dialog, spies } = await openRuns([
      makeRun({
        status: 'waiting_review',
        workflowState: {
          autonomy: 'supervised',
          steps,
          currentStepIndex: 1,
          results: [
            { stepId: 's1', name: 'Analisar', output: 'ok' },
            { stepId: 's2', name: 'Implementar', output: '?', kind: 'question' },
          ],
        },
      }),
    ]);
    expect(within(dialog).getByText('Etapa 2 de 3')).toBeInTheDocument();
    expect(stepIcon(dialog, 'Analisar')).toContain('ti-circle-check-filled');
    expect(stepIcon(dialog, 'Implementar')).toContain('ti-circle-dot');
    expect(stepIcon(dialog, 'Revisar')).toMatch(/ti-circle$/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Aprovar e continuar' }));
    await waitFor(() =>
      expect(spies.continueAgentRun).toHaveBeenCalledWith('run-1', { action: 'approve' }),
    );
    await waitFor(() => expect(spies.getAgentRuns).toHaveBeenCalledTimes(2));

    const revise = within(dialog).getByRole('button', { name: 'Pedir ajuste' });
    expect((revise as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByPlaceholderText('Descreva o ajuste necessário...'), {
      target: { value: '  Use outra abordagem  ' },
    });
    await waitFor(() => expect((revise as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(revise);
    await waitFor(() =>
      expect(spies.continueAgentRun).toHaveBeenCalledWith('run-1', {
        action: 'revise',
        answer: 'Use outra abordagem',
      }),
    );
    await waitFor(() =>
      expectValue(within(dialog).getByPlaceholderText('Descreva o ajuste necessário...'), ''),
    );
  });

  it('approves the final result of finished or stateless workflows', async () => {
    const { dialog } = await openRuns([
      makeRun({
        id: 'run-final',
        status: 'waiting_review',
        workflowState: {
          autonomy: 'balanced',
          steps: [steps[0]!],
          currentStepIndex: 1,
          results: [{ stepId: 's1', name: 'Analisar', output: 'ok', kind: 'result' }],
        },
      }),
      makeRun({ id: 'run-plain', status: 'waiting_review', mode: 'host' }),
      makeRun({
        id: 'run-empty',
        workflowState: { autonomy: 'autonomous', steps: [], currentStepIndex: 0, results: [] },
      }),
    ]);
    expect(within(dialog).getAllByRole('button', { name: 'Aprovar resultado final' })).toHaveLength(
      2,
    );
    expect(
      within(dialog).getByText('Aprovar resultado final', { selector: 'p' }),
    ).toBeInTheDocument();
    expect(stepIcon(dialog, 'Analisar')).toContain('ti-circle-check-filled');
  });

  it('highlights the running step and leaves failed steps plain', async () => {
    const { dialog } = await openRuns([
      makeRun({
        id: 'run-active',
        status: 'running',
        workflowState: {
          autonomy: 'autonomous',
          steps: [steps[0]!],
          currentStepIndex: 0,
          results: [],
        },
      }),
      makeRun({
        id: 'run-failed',
        status: 'failed',
        workflowState: {
          autonomy: 'autonomous',
          steps: [steps[2]!],
          currentStepIndex: 0,
          results: [],
        },
      }),
    ]);
    expect(stepIcon(dialog, 'Analisar')).toContain('ti-circle-dot');
    expect(within(dialog).getByText('Analisar').parentElement!.className).toContain(
      'text-amber-300',
    );
    expect(stepIcon(dialog, 'Revisar')).toMatch(/ti-circle$/);
  });

  it('answers the question of a paused step', async () => {
    const { dialog, spies } = await openRuns([
      makeRun({
        status: 'waiting_input',
        workflowState: {
          autonomy: 'supervised',
          steps,
          currentStepIndex: 0,
          results: [{ stepId: 's1', name: 'Analisar', output: 'prod', kind: 'answer' }],
          question: 'Qual ambiente?',
        },
      }),
    ]);
    expect(within(dialog).getByText('Qual ambiente?')).toBeInTheDocument();
    expect(stepIcon(dialog, 'Analisar')).toContain('ti-circle-dot');
    const answer = within(dialog).getByPlaceholderText(
      'Escreva sua resposta para continuar esta etapa...',
    );
    fireEvent.submit(answer.closest('form')!);
    expect(spies.continueAgentRun).not.toHaveBeenCalled();
    fireEvent.change(answer, { target: { value: ' Homologação ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar resposta' }));
    await waitFor(() =>
      expect(spies.continueAgentRun).toHaveBeenCalledWith('run-1', {
        action: 'answer',
        answer: 'Homologação',
      }),
    );
    await waitFor(() => expectValue(answer, ''));
  });

  it('shows paused runs without actions to read-only members', async () => {
    const { dialog } = await openRuns(
      [
        makeRun({ id: 'r1', status: 'waiting_review' }),
        makeRun({
          id: 'r2',
          status: 'waiting_input',
          workflowState: {
            autonomy: 'supervised',
            steps,
            currentStepIndex: 0,
            results: [],
            question: 'Qual?',
          },
        }),
      ],
      { isReadOnly: true },
    );
    expect(within(dialog).getByText('Etapa 1 de 3')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Aprovar/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Enviar resposta' })).toBeNull();
  });
});
