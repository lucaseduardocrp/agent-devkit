import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { DevelopmentView } from '../src/features/development/DevelopmentView.js';
import {
  REFRESH_INTERVAL_MS,
  type DevChange,
  type DevelopmentSection,
  type DevSession,
  type Pipeline,
} from '../src/features/development/development-types.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';

const change = (fields: Partial<DevChange> = {}): DevChange => ({
  id: 'c1',
  slug: 'add-login',
  title: 'Add login',
  summary: '',
  framework: 'openspec',
  status: 'draft',
  artifacts: [
    { id: 'a1', kind: 'proposal', path: 'openspec/changes/add-login/proposal.md', content: '' },
    {
      id: 'a2',
      kind: 'tasks',
      path: 'openspec/changes/add-login/tasks.md',
      content: '- [ ] 1.1 Build the form',
    },
  ],
  repository: null,
  specificationId: null,
  updatedAt: '2026-11-10T10:00:00.000Z',
  ...fields,
});

const session = (fields: Partial<DevSession> = {}): DevSession => ({
  id: 's1',
  changeId: 'c1',
  title: 'Implement login',
  prompt: 'Do it',
  cli: 'claude',
  status: 'waiting_review',
  attempt: 1,
  worktree: { branch: 'adk/add-login-1a2b3c4d', baseBranch: 'main', path: null },
  context: { windowTokens: 200000, usedTokens: 50000, compactAtPercent: 80, compactions: 0 },
  maxSubagents: 3,
  subagents: [],
  events: [
    {
      id: 'e1',
      at: '2026-11-10T10:00:00.000Z',
      kind: 'status',
      text: 'Session queued.',
      subagentId: null,
    },
  ],
  diff: [],
  comments: [],
  summary: '',
  error: null,
  runner: null,
  updatedAt: '2026-11-10T10:00:00.000Z',
  ...fields,
});

const emptyPipeline: Pipeline = { spec: [], approval: [], code: [], review: [], done: [] };

const repositories = [
  { id: '42', provider: 'github' as const, name: 'acme/shop', defaultBranch: 'main' },
  {
    id: 'guid-1',
    provider: 'azure_devops' as const,
    name: 'Finance/app',
    defaultBranch: 'develop',
  },
];
const branchesOf = (id: string) =>
  id === '42'
    ? [
        { name: 'main', isDefault: true },
        { name: 'feature/login', isDefault: false },
      ]
    : [{ name: 'develop', isDefault: true }];

function mockClient(
  data: {
    changes?: DevChange[];
    sessions?: DevSession[];
    pipeline?: Pipeline;
    repositories?: typeof repositories;
  } = {},
) {
  return {
    getToken: vi.fn().mockReturnValue('tok'),
    getDevelopmentChanges: vi.fn().mockResolvedValue(data.changes ?? []),
    getDevelopmentSessions: vi.fn().mockResolvedValue(data.sessions ?? []),
    getAgents: vi.fn().mockResolvedValue([]),
    searchPbiItems: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'p1',
          kind: 'pbi',
          title: 'Fix login',
          status: 'New',
          type: 'Bug',
          links: [{ providerId: 'azure_devops', externalId: '1234', externalUrl: null }],
        },
      ],
      total: 1,
    }),
    searchIssues: vi.fn().mockResolvedValue({
      issues: [{ id: 'i1', number: 7, title: 'Slow page' }],
      total: 1,
    }),
    getDevelopmentRepositories: vi.fn().mockResolvedValue(data.repositories ?? []),
    getDevelopmentBranches: vi
      .fn()
      .mockImplementation((_provider: string, id: string) => Promise.resolve(branchesOf(id))),
    getDevelopmentPipeline: vi.fn().mockResolvedValue(data.pipeline ?? emptyPipeline),
    createDevelopmentChange: vi.fn().mockResolvedValue(change({ id: 'c-new' })),
    updateDevelopmentChange: vi.fn().mockResolvedValue(change()),
    transitionDevelopmentChange: vi.fn().mockResolvedValue(change()),
    deleteDevelopmentChange: vi.fn().mockResolvedValue(undefined),
    createDevelopmentSession: vi.fn().mockResolvedValue(session({ id: 's-new' })),
    changeDevelopmentSession: vi.fn().mockResolvedValue(session()),
    reviewDevelopmentSession: vi.fn().mockResolvedValue(session()),
    addDevelopmentComment: vi.fn().mockResolvedValue(session()),
    resolveDevelopmentComment: vi.fn().mockResolvedValue(session()),
    deleteDevelopmentSession: vi.fn().mockResolvedValue(undefined),
  };
}

type Client = ReturnType<typeof mockClient>;

function element(
  api: Client,
  section: DevelopmentSection,
  onSelectSection: () => void,
  readOnly = false,
) {
  return (
    <DevelopmentView
      apiClient={api as unknown as ApiClient}
      workspaceId="ws"
      section={section}
      onSelectSection={onSelectSection}
      isReadOnly={readOnly}
    />
  );
}

/** Renders one screen and waits for its data; `to` moves the same view to another screen. */
async function show(api: Client, section: DevelopmentSection, readOnly = false) {
  const onSelectSection = vi.fn();
  const view = render(element(api, section, onSelectSection, readOnly));
  await waitFor(() => expect(api.getDevelopmentPipeline).toHaveBeenCalled());
  await waitFor(() => expect(view.container.querySelector('.animate-pulse')).toBeNull());
  const to = (next: DevelopmentSection) =>
    view.rerender(element(api, next, onSelectSection, readOnly));
  return { view, onSelectSection, to };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const click = (name: string | RegExp) => fireEvent.click(button(name));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => {
  vi.useRealTimers();
});

describe('DevelopmentView', () => {
  it('shows an empty module without asking the API when there is no workspace', async () => {
    const api = mockClient();
    render(
      <DevelopmentView
        apiClient={api as unknown as ApiClient}
        workspaceId={null}
        section="artifacts"
        onSelectSection={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Nenhuma change ainda/)).toBeInTheDocument();
    expect(api.getDevelopmentChanges).not.toHaveBeenCalled();
  });

  it('reports a load failure with its own message, or a generic one', async () => {
    const offline = mockClient({ changes: [change()] });
    offline.getDevelopmentChanges.mockRejectedValueOnce(new Error('API offline'));
    await show(offline, 'artifacts');
    expect(await screen.findByRole('alert')).toHaveTextContent('API offline');
    cleanup();

    const down = mockClient({ changes: [change()] });
    down.getDevelopmentChanges.mockRejectedValueOnce('down');
    await show(down, 'artifacts');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar o módulo Development.',
    );
  });

  it('reports action failures', async () => {
    const api = mockClient({ changes: [change()] });
    await show(api, 'artifacts');
    click(/Add login/);
    api.transitionDevelopmentChange.mockRejectedValueOnce(new Error('Not allowed'));
    click('Propor');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed');
    api.transitionDevelopmentChange.mockRejectedValueOnce('nope');
    click('Propor');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível concluir a ação.'),
    );
  });

  it('keeps refreshing while a runner still has work to report', async () => {
    vi.useFakeTimers();
    const api = mockClient({ sessions: [session({ status: 'running' })] });
    const view = render(element(api, 'code', vi.fn()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getDevelopmentSessions).toHaveBeenCalledTimes(1);
    api.getDevelopmentSessions.mockResolvedValue([session({ status: 'waiting_review' })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(api.getDevelopmentSessions).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    });
    expect(api.getDevelopmentSessions).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});

describe('Development artifacts', () => {
  it('creates a change with and without a summary', async () => {
    const api = mockClient();
    await show(api, 'artifacts');
    click(/Nova change/);
    expect(button('Criar change')).toHaveAttribute('disabled');
    type('Título', 'Add login');
    type('Framework', 'speckit');
    type('Resumo', 'Single sign-on');
    click('Criar change');
    await waitFor(() =>
      expect(api.createDevelopmentChange).toHaveBeenCalledWith({
        title: 'Add login',
        framework: 'speckit',
        summary: 'Single sign-on',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());

    click(/Nova change/);
    type('Título', 'Plain');
    click('Criar change');
    await waitFor(() =>
      expect(api.createDevelopmentChange).toHaveBeenLastCalledWith({
        title: 'Plain',
        framework: 'speckit',
      }),
    );
    click(/Nova change/);
    click('Cancelar');
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('reads and edits the artifacts of a change', async () => {
    const api = mockClient({ changes: [change({ summary: 'Single sign-on' })] });
    await show(api, 'artifacts');
    expect(screen.getByLabelText('Buscar changes')).toBeInTheDocument();
    click(/Add login/);
    expect(screen.queryByText('Single sign-on')).toBeNull();
    click(/Ver resumo/);
    expect(screen.getByText('Single sign-on')).toBeInTheDocument();
    click(/Ocultar resumo/);
    expect(screen.queryByText('Single sign-on')).toBeNull();
    expect(screen.getByText('Este artefato ainda está vazio.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'tasks.md' }));
    expect(screen.getByRole('tab', { name: 'tasks.md' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/1\.1 Build the form/)).toBeInTheDocument();

    click(/Editar/);
    click('Cancelar');
    click(/Editar/);
    type('Conteúdo de openspec/changes/add-login/tasks.md', '- [x] 1.1 Build the form');
    click('Salvar');
    await waitFor(() =>
      expect(api.updateDevelopmentChange).toHaveBeenCalledWith('c1', {
        artifacts: [
          expect.objectContaining({ id: 'a1', content: '' }),
          expect.objectContaining({ id: 'a2', content: '- [x] 1.1 Build the form' }),
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByText('Salvar')).toBeNull());
  });

  it('offers the moves of each status and starts a session of an approved change', async () => {
    const api = mockClient({
      changes: [
        change({ id: 'p', title: 'Proposed', status: 'proposed' }),
        change({ id: 'ok', title: 'Approved', status: 'approved' }),
        change({ id: 'no', title: 'Rejected', status: 'rejected' }),
        change({ id: 'old', title: 'Archived', status: 'archived', artifacts: [] }),
      ],
    });
    const { onSelectSection } = await show(api, 'artifacts');
    click(/^Proposed/);
    for (const name of ['Aprovar', 'Rejeitar', 'Reabrir']) expect(button(name)).toBeInTheDocument();
    click('Aprovar');
    await waitFor(() =>
      expect(api.transitionDevelopmentChange).toHaveBeenCalledWith('p', 'approve'),
    );

    click(/Ver changes/);
    click(/^Approved/);
    expect(button('Arquivar')).toBeInTheDocument();
    click(/Iniciar sessão/);
    expect(onSelectSection).toHaveBeenCalledWith('code');

    click(/Ver changes/);
    click(/^Rejected/);
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull();
    click(/Ver changes/);
    click(/^Archived/);
    expect(screen.getByText('Esta change não tem artefatos.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Arquivar' })).toBeNull();

    click('Excluir');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancelar'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    click('Excluir');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Excluir'));
    await waitFor(() => expect(api.deleteDevelopmentChange).toHaveBeenCalledWith('old'));
  });

  it('searches and filters the list of changes and goes back to it', async () => {
    const api = mockClient({
      changes: [
        change({ id: 'p', title: 'Proposed one', slug: 'prop', status: 'proposed' }),
        change({ id: 'ok', title: 'Approved one', slug: 'appr', status: 'approved' }),
      ],
    });
    await show(api, 'artifacts');
    type('Buscar changes', 'APPR');
    expect(screen.queryByRole('button', { name: /Proposed one/ })).toBeNull();
    expect(button(/Approved one/)).toBeInTheDocument();
    type('Buscar changes', '');
    type('Status', 'proposed');
    expect(screen.queryByRole('button', { name: /Approved one/ })).toBeNull();
    type('Buscar changes', 'nothing');
    expect(screen.getByText('Nenhuma change corresponde aos filtros.')).toBeInTheDocument();
    type('Buscar changes', '');
    type('Status', '');
    click(/Approved one/);
    click(/Ver changes/);
    expect(button(/Proposed one/)).toBeInTheDocument();
  });

  it('is read-only without edit access and hides delete without delete access', async () => {
    const api = mockClient({ changes: [change({ artifacts: [change().artifacts[1]!] })] });
    const readOnly = await show(api, 'artifacts', true);
    click(/Add login/);
    for (const name of [/Nova change/, 'Propor', /Editar/, 'Excluir'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    readOnly.view.unmount();

    render(
      <PermissionsProvider
        access={{ ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, development: 'edit' } }}
      >
        {element(api, 'artifacts', vi.fn())}
      </PermissionsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Add login/ }));
    expect(button('Propor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
  });
});

describe('Development code', () => {
  it('searches and filters the list of sessions', async () => {
    const api = mockClient({
      sessions: [
        session({ id: 'a', title: 'First one', status: 'running', cli: 'claude' }),
        session({ id: 'b', title: 'Second one', status: 'queued', cli: 'codex' }),
      ],
    });
    await show(api, 'code');
    type('Buscar sessões', 'second');
    expect(screen.queryByRole('button', { name: /First one/ })).toBeNull();
    type('Buscar sessões', '');
    type('Status', 'running');
    expect(screen.queryByRole('button', { name: /Second one/ })).toBeNull();
    type('Status', '');
    type('CLI', 'codex');
    expect(screen.queryByRole('button', { name: /First one/ })).toBeNull();
    type('Buscar sessões', 'nothing');
    expect(screen.getByText('Nenhuma sessão corresponde aos filtros.')).toBeInTheDocument();
  });

  it('never takes negative numbers and sends the picked workspace agents', async () => {
    const api = mockClient({ changes: [change({ status: 'approved' })] });
    api.getAgents.mockResolvedValue([
      { id: 'a1', name: 'Reviewer', description: 'Reviews code' },
      { id: 'a2', name: 'Tester', description: 'Writes tests' },
    ]);
    const { to } = await show(api, 'artifacts');
    click(/Add login/);
    click(/Iniciar sessão/);
    to('code');
    const compact = screen.getByLabelText('Compactar contexto em (%)');
    const subagents = screen.getByLabelText('Máximo de subagentes');
    expect(fireEvent.keyDown(compact, { key: '-' })).toBe(false);
    fireEvent.change(compact, { target: { value: '-50' } });
    fireEvent.change(subagents, { target: { value: '-1' } });
    expect((compact as HTMLInputElement).value).toBe('50');
    expect((subagents as HTMLInputElement).value).toBe('1');
    fireEvent.change(subagents, { target: { value: '' } });
    fireEvent.focus(await screen.findByRole('combobox', { name: 'Agentes' }));
    fireEvent.click(await screen.findByRole('option', { name: /Tester/ }));
    click('Enfileirar sessão');
    await waitFor(() =>
      expect(api.createDevelopmentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          compactAtPercent: 50,
          maxSubagents: 0,
          agentIds: ['a2'],
        }),
      ),
    );
  });

  it('queues a session for the change picked in Artifacts', async () => {
    const api = mockClient({ changes: [change({ status: 'approved' })] });
    const { to } = await show(api, 'artifacts');
    click(/Add login/);
    click(/Iniciar sessão/);
    to('code');
    expect(screen.getByLabelText('Título')).toHaveAttribute('value', 'Add login');
    expect((screen.getByLabelText('Instruções para o agente') as HTMLTextAreaElement).value).toBe(
      'Implemente a change add-login seguindo a proposta, o design e as tarefas.',
    );
    click('Enfileirar sessão');
    await waitFor(() =>
      expect(api.createDevelopmentSession).toHaveBeenCalledWith({
        title: 'Add login',
        prompt: 'Implemente a change add-login seguindo a proposta, o design e as tarefas.',
        cli: 'claude',
        compactAtPercent: 80,
        maxSubagents: 3,
        changeId: 'c1',
      }),
    );
  });

  it('links the session to a PBI and an issue picked from searchable, paged lists', async () => {
    const api = mockClient();
    await show(api, 'code');
    click(/Nova sessão/);
    await waitFor(() =>
      expect(api.searchPbiItems).toHaveBeenCalledWith(
        { q: '', page: 1, pageSize: 25 },
        expect.any(AbortSignal),
      ),
    );
    expect(api.searchIssues).toHaveBeenCalledWith(
      { q: '', page: 1, pageSize: 25 },
      expect.any(AbortSignal),
    );
    type('Título', 'Fix login');
    type('Instruções para o agente', 'Go');
    fireEvent.focus(screen.getByRole('combobox', { name: 'PBI' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Bug #1234 · Fix login' }));
    fireEvent.focus(screen.getByRole('combobox', { name: 'Issue' }));
    fireEvent.click(await screen.findByRole('option', { name: '#7 · Slow page' }));
    click('Enfileirar sessão');
    await waitFor(() =>
      expect(api.createDevelopmentSession).toHaveBeenCalledWith(
        expect.objectContaining({ pbiItemId: 'p1', issueId: 'i1' }),
      ),
    );
  });

  it('queues a session without links when no PBI or issue is picked', async () => {
    const api = mockClient();
    await show(api, 'code');
    click(/Nova sessão/);
    type('Título', 'Plain');
    type('Instruções para o agente', 'Go');
    click('Enfileirar sessão');
    await waitFor(() => expect(api.createDevelopmentSession).toHaveBeenCalled());
    const sent = api.createDevelopmentSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('pbiItemId');
    expect(sent).not.toHaveProperty('issueId');
  });

  it('queues an ad-hoc session with its own settings', async () => {
    const api = mockClient({
      changes: [change({ status: 'approved' }), change({ id: 'd' })],
      repositories,
    });
    await show(api, 'code');
    expect(screen.getByText(/Nenhuma sessão ainda/)).toBeInTheDocument();
    click(/Nova sessão/);
    expect(screen.getByLabelText('Change').querySelectorAll('option')).toHaveLength(2);
    type('Título', 'Fix typo');
    type('Instruções para o agente', 'Fix the typo in the README');
    type('Change', 'c1');
    type('Change', '');
    type('CLI do agente', 'codex');
    expect(screen.getByLabelText('Branch').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Escolha um repositório primeiro')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Repositories').hasAttribute('disabled')).toBe(false),
    );
    expect(
      [...screen.getByLabelText('Repositories').querySelectorAll('option')].map(
        (o) => o.textContent,
      ),
    ).toEqual(['Escolha um repositório', 'GitHub · acme/shop', 'Azure DevOps · Finance/app']);
    type('Repositories', 'azure_devops:guid-1');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Branch').value).toBe('develop'),
    );
    expect(api.getDevelopmentBranches).toHaveBeenLastCalledWith('azure_devops', 'guid-1');
    type('Repositories', 'github:42');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Branch').value).toBe('main'),
    );
    expect(
      [...screen.getByLabelText('Branch').querySelectorAll('option')].map((o) => o.textContent),
    ).toEqual(['Escolha uma branch', 'main', 'feature/login']);
    type('Branch', 'feature/login');
    type('Compactar contexto em (%)', '60');
    type('Máximo de subagentes', '0');
    click('Enfileirar sessão');
    await waitFor(() =>
      expect(api.createDevelopmentSession).toHaveBeenCalledWith({
        title: 'Fix typo',
        prompt: 'Fix the typo in the README',
        cli: 'codex',
        compactAtPercent: 60,
        maxSubagents: 0,
        repository: {
          provider: 'github',
          id: '42',
          name: 'acme/shop',
          baseBranch: 'feature/login',
        },
        baseBranch: 'feature/login',
      }),
    );
    click(/Nova sessão/);
    click('Cancelar');
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('cuts a long label with an ellipsis and keeps its full text on hover', async () => {
    await show(mockClient(), 'code');
    click(/Nova sessão/);
    const label = screen.getByText('Compactar contexto em (%)');
    expect(label).toHaveAttribute('title', 'Compactar contexto em (%)');
    expect(label).toHaveClass('truncate');
  });

  it('brings the repository and branch of the change, and falls back to the default branch', async () => {
    const api = mockClient({
      repositories,
      changes: [
        change({
          status: 'approved',
          repository: {
            provider: 'github',
            id: '42',
            name: 'acme/shop',
            baseBranch: 'feature/login',
          },
        }),
        change({
          id: 'old',
          slug: 'old',
          title: 'Old',
          status: 'approved',
          repository: { provider: 'github', id: '42', name: 'acme/shop', baseBranch: 'deleted' },
        }),
        change({ id: 'free', slug: 'free', title: 'Free', status: 'approved' }),
      ],
    });
    const { to } = await show(api, 'artifacts');
    click(/Add login/);
    click(/Iniciar sessão/);
    to('code');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Branch').value).toBe('feature/login'),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Repositories').value).toBe('github:42');
    click('Enfileirar sessão');
    await waitFor(() =>
      expect(api.createDevelopmentSession).toHaveBeenCalledWith(
        expect.objectContaining({ baseBranch: 'feature/login', changeId: 'c1' }),
      ),
    );

    click(/Nova sessão/);
    type('Change', 'old');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Branch').value).toBe('main'),
    );
    // A change without a repository keeps what was picked.
    type('Change', 'free');
    expect(screen.getByLabelText<HTMLSelectElement>('Repositories').value).toBe('github:42');
  });

  it('ignores answers that arrive after the person moved on', async () => {
    const api = mockClient({ repositories });
    const late: { resolve: (list: ReturnType<typeof branchesOf>) => void; fail: () => void }[] = [];
    api.getDevelopmentBranches.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          late.push({ resolve, fail: () => reject(new Error('stale failure')) });
        }),
    );
    const { view } = await show(api, 'code');
    click(/Nova sessão/);
    await waitFor(() =>
      expect(screen.getByLabelText('Repositories').hasAttribute('disabled')).toBe(false),
    );
    type('Repositories', 'github:42');
    type('Repositories', 'azure_devops:guid-1');
    await act(async () => {
      late[0]!.resolve(branchesOf('42'));
      await Promise.resolve();
    });
    expect(screen.getByLabelText<HTMLSelectElement>('Branch').hasAttribute('disabled')).toBe(true);
    type('Repositories', 'github:42');
    await act(async () => {
      late[1]!.fail();
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    view.unmount();
  });

  it('ignores the repositories that arrive after the screen was left', async () => {
    const api = mockClient({ repositories });
    let finish: (value: typeof repositories) => void = () => {};
    api.getDevelopmentRepositories.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { view } = await show(api, 'code');
    view.unmount();
    await act(async () => finish(repositories));
    const failing = mockClient({ repositories });
    let fail: (reason: Error) => void = () => {};
    failing.getDevelopmentRepositories.mockImplementation(
      () => new Promise((_resolve, reject) => (fail = reject)),
    );
    const second = await show(failing, 'code');
    second.view.unmount();
    await act(async () => fail(new Error('late')));
  });

  it('says why the repositories could not be loaded', async () => {
    const api = mockClient({ repositories });
    api.getDevelopmentRepositories.mockRejectedValueOnce(new Error('Provider down'));
    await show(api, 'code');
    click(/Nova sessão/);
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider down');
    expect(screen.getByText('Nenhum repositório. Configure uma integração')).toBeInTheDocument();
    expect(screen.getByLabelText('Repositories').hasAttribute('disabled')).toBe(true);
  });

  it('uses a generic message when the repositories fail without one', async () => {
    const api = mockClient({ repositories });
    api.getDevelopmentRepositories.mockRejectedValueOnce('boom');
    await show(api, 'code');
    click(/Nova sessão/);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar os repositórios.',
    );
  });

  it('says why the branches could not be loaded and lets the repository be changed', async () => {
    const api = mockClient({ repositories });
    api.getDevelopmentBranches
      .mockRejectedValueOnce(new Error('No access'))
      .mockRejectedValueOnce('boom');
    await show(api, 'code');
    click(/Nova sessão/);
    await waitFor(() =>
      expect(screen.getByLabelText('Repositories').hasAttribute('disabled')).toBe(false),
    );
    type('Repositories', 'github:42');
    expect(await screen.findByRole('alert')).toHaveTextContent('No access');
    expect(screen.getByLabelText('Branch').hasAttribute('disabled')).toBe(true);
    type('Repositories', 'azure_devops:guid-1');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as branches.'),
    );
    type('Repositories', '');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('follows a running session: worktree, context, subagents and timeline', async () => {
    const api = mockClient({
      sessions: [
        session({
          status: 'running',
          runner: 'laptop',
          summary: 'Half way',
          worktree: { branch: 'adk/x', baseBranch: 'main', path: '/work/x' },
          context: { windowTokens: 1000, usedTokens: 900, compactAtPercent: 80, compactions: 2 },
          subagents: [
            {
              id: 'a',
              name: 'Tests',
              role: 'qa',
              status: 'failed',
              summary: 'Red',
              usedTokens: 1200,
            },
            { id: 'b', name: 'Docs', role: '', status: 'done', summary: '', usedTokens: 5 },
          ],
        }),
      ],
    });
    await show(api, 'code');
    expect(screen.getByRole('region', { name: 'Sessões' })).toBeInTheDocument();
    click(/Implement login/);
    expect(screen.getByText('laptop')).toBeInTheDocument();
    expect(screen.getByText('/work/x')).toBeInTheDocument();
    // The summary is read on demand.
    expect(screen.queryByText('Half way')).toBeNull();
    click('Ver resumo');
    expect(screen.getByText('Half way')).toBeInTheDocument();
    click('Ocultar resumo');
    expect(screen.queryByText('Half way')).toBeNull();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '90');
    expect(screen.getByText('90% usado')).toBeInTheDocument();
    expect(screen.getByText('900 / 1k')).toBeInTheDocument();
    expect(screen.getByText('0 até a compactação automática')).toBeInTheDocument();
    expect(screen.getByText('a partir de main')).toBeInTheDocument();
    expect(screen.getByText('2 compactações · limite em 80%')).toBeInTheDocument();
    expect(screen.getByText('qa · 1.2k tokens')).toBeInTheDocument();
    expect(screen.getByText('5 tokens')).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Session queued.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
    click('Cancelar sessão');
    await waitFor(() => expect(api.changeDevelopmentSession).toHaveBeenCalledWith('s1', 'cancel'));
  });

  it('offers what each status allows: wait, retry, review and delete', async () => {
    const api = mockClient({
      sessions: [
        session({ id: 'q', title: 'Queued one', status: 'queued' }),
        session({ id: 'f', title: 'Failed one', status: 'failed', error: 'Tests are red' }),
        session({ id: 'w', title: 'Waiting one', status: 'waiting_review' }),
        session({ id: 'ok', title: 'Approved one', status: 'approved' }),
      ],
    });
    const { onSelectSection } = await show(api, 'code');
    click(/Queued one/);
    expect(screen.getByText(/Aguardando um runner assumir esta sessão/)).toBeInTheDocument();
    expect(screen.getByText('Será criada pelo runner')).toBeInTheDocument();
    expect(screen.getByText('Nenhum runner ainda')).toBeInTheDocument();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Terminal' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Escolher pasta/ })).toBeNull();
    expect(screen.getByText('Nenhum subagente foi usado.')).toBeInTheDocument();

    click('Ver sessões');
    click(/Failed one/);
    expect(screen.getByRole('alert')).toHaveTextContent('Tests are red');
    click('Tentar novamente');
    await waitFor(() => expect(api.changeDevelopmentSession).toHaveBeenCalledWith('f', 'retry'));

    click('Ver sessões');
    click(/Waiting one/);
    // Without a summary there is nothing to view.
    expect(screen.queryByRole('button', { name: 'Ver resumo' })).toBeNull();
    click(/Abrir revisão/);
    expect(onSelectSection).toHaveBeenCalledWith('review');

    click('Ver sessões');
    click(/Approved one/);
    expect(screen.queryByRole('button', { name: 'Cancelar sessão' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    click('Excluir');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancelar'));
    click('Excluir');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Excluir'));
    await waitFor(() => expect(api.deleteDevelopmentSession).toHaveBeenCalledWith('ok'));
  });

  it('only shows the work to a read-only member', async () => {
    const api = mockClient({
      changes: [change({ status: 'approved' })],
      sessions: [session({ status: 'failed' })],
      pipeline: {
        ...emptyPipeline,
        code: [
          {
            changeId: 'c1',
            slug: 'add-login',
            title: 'Add login',
            status: 'approved',
            tasks: { done: 0, total: 0 },
            session: null,
          },
        ],
      },
    });
    const { to } = await show(api, 'pipeline', true);
    click(/Add login/);
    to('code');
    expect(screen.queryByLabelText('Título')).toBeNull();
    click(/Implement login/);
    for (const name of [/Nova sessão/, 'Tentar novamente', 'Excluir'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('Development review', () => {
  const reviewed = () =>
    session({
      summary: 'Login added',
      diff: [
        {
          path: 'src/login.ts',
          status: 'added',
          additions: 2,
          deletions: 0,
          patch: '@@ -0,0 +1,2 @@\n+const a = 1;\n\n context',
        },
        { path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 1, patch: '-gone' },
        { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '-a\n+b' },
        { path: 'src/b.ts', status: 'renamed', additions: 0, deletions: 0, patch: '' },
      ],
      comments: [
        {
          id: 'm1',
          author: 'user',
          authorName: 'Alice',
          path: 'src/login.ts',
          line: 12,
          body: 'Handle the empty password',
          resolved: false,
          createdAt: '2026-11-10T10:00:00.000Z',
        },
        {
          id: 'm2',
          author: 'agent',
          authorName: 'Claude',
          path: 'src/a.ts',
          line: null,
          body: 'Covered by a test',
          resolved: true,
          createdAt: '2026-11-10T10:01:00.000Z',
        },
        {
          id: 'm3',
          author: 'user',
          authorName: 'Bob',
          path: null,
          line: null,
          body: 'Looks good overall',
          resolved: false,
          createdAt: '2026-11-10T10:02:00.000Z',
        },
      ],
    });

  it('reads the diff of a session file by file', async () => {
    const api = mockClient({
      sessions: [reviewed(), session({ id: 'q', title: 'Queued', status: 'queued' })],
    });
    await show(api, 'review');
    expect(screen.queryByRole('button', { name: /Queued/ })).toBeNull();
    expect(screen.getByLabelText('Buscar revisões')).toBeInTheDocument();
    click(/Implement login/);
    expect(screen.getByText('Login added')).toBeInTheDocument();
    const diff = screen.getByLabelText('Diff de src/login.ts');
    expect(diff.querySelectorAll('span')).toHaveLength(4);
    expect(diff.querySelector('.text-green-300')).toHaveTextContent('+const a = 1;');
    click(/src\/old\.ts/);
    expect(
      screen.getByLabelText('Diff de src/old.ts').querySelector('.text-red-300'),
    ).toHaveTextContent('-gone');
    expect(screen.getByText('src/login.ts:12')).toBeInTheDocument();
    expect(screen.getByText('Resolvido')).toBeInTheDocument();
    expect(screen.getByText('Agente')).toBeInTheDocument();
  });

  it('comments, resolves and decides', async () => {
    const api = mockClient({ sessions: [reviewed()] });
    await show(api, 'review');
    click(/Implement login/);

    expect(button('Comentar')).toHaveAttribute('disabled');
    type('Comentar', ' Why this name? ');
    type('Arquivo do comentário', 'src/a.ts');
    click('Comentar');
    await waitFor(() =>
      expect(api.addDevelopmentComment).toHaveBeenCalledWith('s1', 'Why this name?', 'src/a.ts'),
    );
    type('Arquivo do comentário', '');
    type('Comentar', 'General remark');
    click('Comentar');
    await waitFor(() =>
      expect(api.addDevelopmentComment).toHaveBeenLastCalledWith('s1', 'General remark', undefined),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Resolver' })[0]!);
    await waitFor(() =>
      expect(api.resolveDevelopmentComment).toHaveBeenCalledWith('s1', 'm1', true),
    );
    click('Reabrir');
    await waitFor(() =>
      expect(api.resolveDevelopmentComment).toHaveBeenLastCalledWith('s1', 'm2', false),
    );

    type('Nota para o agente (opcional)', ' See the comments ');
    click(/Pedir ajustes/);
    await waitFor(() =>
      expect(api.reviewDevelopmentSession).toHaveBeenCalledWith(
        's1',
        'request_changes',
        'See the comments',
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Nota para o agente (opcional)')).toHaveAttribute('value', ''),
    );
    click(/Aprovar/);
    await waitFor(() =>
      expect(api.reviewDevelopmentSession).toHaveBeenLastCalledWith('s1', 'approve', undefined),
    );
  });

  it('shows an approved or read-only review without the decision', async () => {
    const api = mockClient({ sessions: [session({ status: 'approved' })] });
    const approved = await show(api, 'review');
    click(/Implement login/);
    expect(screen.getByText('O runner ainda não enviou o diff desta sessão.')).toBeInTheDocument();
    expect(screen.getByText('Nenhum comentário.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pedir ajustes/ })).toBeNull();
    approved.view.unmount();

    const readOnlyApi = mockClient({ sessions: [reviewed()] });
    await show(readOnlyApi, 'review', true);
    click(/Implement login/);
    for (const name of ['Comentar', 'Resolver', /Aprovar/])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('searches and filters the list of reviews', async () => {
    const api = mockClient({
      sessions: [
        reviewed(),
        session({ id: 'ap', title: 'Approved one', status: 'approved', cli: 'codex' }),
      ],
    });
    await show(api, 'review');
    type('Buscar revisões', 'implement');
    expect(screen.queryByRole('button', { name: /Approved one/ })).toBeNull();
    type('Buscar revisões', '');
    type('Status', 'approved');
    expect(screen.queryByRole('button', { name: /Implement login/ })).toBeNull();
    type('Status', '');
    type('CLI', 'codex');
    expect(screen.queryByRole('button', { name: /Implement login/ })).toBeNull();
    type('Buscar revisões', 'nothing');
    expect(screen.getByText('Nenhuma revisão corresponde aos filtros.')).toBeInTheDocument();
    type('Buscar revisões', '');
    type('CLI', '');
    click(/Implement login/);
    click(/Ver revisões/);
    expect(button(/Approved one/)).toBeInTheDocument();
  });

  it('says so when nothing waits for review', async () => {
    await show(mockClient(), 'review');
    expect(screen.getByText(/Nada para revisar/)).toBeInTheDocument();
  });
});

describe('Development pipeline', () => {
  const item = (fields: object) => ({
    changeId: 'c1',
    slug: 'add-login',
    title: 'Add login',
    status: 'approved' as const,
    tasks: { done: 1, total: 3 },
    session: null,
    ...fields,
  });
  const active = { id: 's1', status: 'waiting_review' as const, attempt: 1, branch: 'adk/x' };

  it('shows each change at its stage and opens the screen that moves it on', async () => {
    const api = mockClient({
      changes: [change({ status: 'approved' })],
      sessions: [session()],
      pipeline: {
        spec: [
          item({
            changeId: 'd',
            title: 'Draft idea',
            status: 'draft',
            tasks: { done: 0, total: 0 },
          }),
        ],
        approval: [],
        code: [
          item({ changeId: 'c1', title: 'Needs a session' }),
          item({ changeId: 'r', title: 'Running one', session: { ...active, status: 'running' } }),
        ],
        review: [item({ changeId: 'w', title: 'Waiting one', session: active })],
        done: [],
      },
    });
    const { onSelectSection, to } = await show(api, 'pipeline');
    expect(
      within(screen.getByLabelText('Aprovação')).getByText('Nada nesta etapa.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('1/3 tarefas')).toHaveLength(3);
    expect(within(screen.getByLabelText('Spec')).queryByText(/tarefas/)).toBeNull();

    click(/Draft idea/);
    expect(onSelectSection).toHaveBeenLastCalledWith('artifacts');
    click(/Running one/);
    expect(onSelectSection).toHaveBeenLastCalledWith('code');
    click(/Waiting one/);
    expect(onSelectSection).toHaveBeenLastCalledWith('review');
    to('review');
    expect(screen.getByRole('heading', { name: 'Implement login' })).toBeInTheDocument();

    to('pipeline');
    click(/Needs a session/);
    expect(onSelectSection).toHaveBeenLastCalledWith('code');
    to('code');
    expect(screen.getByLabelText('Título')).toHaveAttribute('value', 'Add login');
  });
});
