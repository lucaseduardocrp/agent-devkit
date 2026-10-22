import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { WorkView } from '../src/features/issues/WorkView.js';
import type { Issue } from '../src/features/issues/issue-types.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type { EffectiveAccess, ModuleAccess } from '../src/features/workspaces/workspace-types.js';

const issue: Issue = {
  id: 'issue-1',
  workspaceId: 'workspace-a',
  number: 1,
  title: 'Prepare release',
  description: 'Finish the checklist',
  status: 'todo',
  priority: 'high',
  assigneeAgentId: null,
  assigneeUserId: null,
  createdBy: 'user-a',
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
};

function client() {
  return {
    getIssues: vi.fn().mockResolvedValue([issue]),
    getInbox: vi.fn().mockResolvedValue([
      {
        issue,
        runs: [
          {
            id: 'run-1',
            agentId: 'agent-a',
            status: 'succeeded',
            attempt: 1,
            createdAt: issue.updatedAt,
            finishedAt: issue.updatedAt,
          },
        ],
        readAt: null,
        archivedAt: null,
      },
    ]),
    getDashboard: vi.fn().mockResolvedValue({
      agents: [],
      recentIssues: [issue],
      recentActivity: [issue],
      totalIssues: 1,
      inProgress: 0,
      open: 1,
      byStatus: {
        backlog: 0,
        todo: 1,
        in_progress: 0,
        in_review: 0,
        blocked: 0,
        done: 0,
        cancelled: 0,
      },
      byPriority: { urgent: 0, high: 1, medium: 0, low: 0 },
    }),
    getIssue: vi.fn().mockResolvedValue({ issue, comments: [] }),
    createIssue: vi.fn().mockResolvedValue(issue),
    updateInboxItem: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue({
      comment: {
        id: 'comment-1',
        issueId: issue.id,
        authorId: 'user-a',
        body: 'Ready',
        createdAt: issue.createdAt,
      },
    }),
  };
}

describe('WorkView', () => {
  it('formats compact Markdown descriptions, code and comments', async () => {
    const markdownIssue = {
      ...issue,
      description:
        '## Objetivo Construir a biblioteca **core**. ## Referências Use `styles.css`.\n\n```dbml\nTable users {\n  id int [pk]\n}\n```',
    };
    const api = client();
    api.getIssues.mockResolvedValue([markdownIssue]);
    api.getIssue.mockResolvedValue({
      issue: markdownIssue,
      comments: [
        {
          id: 'comment-2',
          issueId: issue.id,
          authorId: 'user-a',
          body: '**Revisado**',
          createdAt: issue.createdAt,
        },
      ],
    });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    expect(await screen.findByRole('heading', { name: /Objetivo Construir/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Referências Use/ })).toBeInTheDocument();
    expect(screen.getByText('core').tagName).toBe('STRONG');
    expect(screen.getByText('dbml')).toBeInTheDocument();
    expect(document.querySelector('pre code')?.textContent).toContain('Table users');
    expect(screen.getByText('Revisado').tagName).toBe('STRONG');
  });

  it('preserves sanitized imported HTML descriptions', async () => {
    const htmlIssue = {
      ...issue,
      description: '<p><strong>Imported</strong> HTML<script>alert(1)</script></p>',
    };
    const api = client();
    api.getIssues.mockResolvedValue([htmlIssue]);
    api.getIssue.mockResolvedValue({ issue: htmlIssue, comments: [] });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    expect(await screen.findByText('Imported')).toBeInTheDocument();
    expect(screen.getByText('Imported').tagName).toBe('STRONG');
    expect(document.querySelector('[role="dialog"] script')).toBeNull();
  });

  it('shows monthly spend and lets admins update the budget', async () => {
    const api = {
      ...client(),
      setMonthlyBudget: vi.fn().mockResolvedValue({}),
      setCostRate: vi.fn().mockResolvedValue({}),
      deleteCostRate: vi.fn().mockResolvedValue(undefined),
    };
    api.getDashboard.mockResolvedValueOnce({
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
      costs: {
        monthSpendMicros: 1_250_000,
        monthlyBudgetMicros: 5_000_000,
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalTokens: 1500,
        unpricedRuns: 0,
        rates: [],
      },
    });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="dashboard"
        currentUserId="user-a"
        canManageCosts
      />,
    );
    await waitFor(() => expect(screen.getAllByText(/US\$\s*1,25/).length).toBeGreaterThan(0));
    expect(screen.getByText(/Total de tokens usados: 1\.500/)).toBeInTheDocument();
    expect(screen.getByText(/Entrada \/ saída: 1\.200 \/ 300/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Orçamento mensal/ }), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api.setMonthlyBudget).toHaveBeenCalledWith(10_000_000));
  });

  it('shows MCP token usage with estimated tokens, spend and top tools', async () => {
    const api = client();
    const summary = await api.getDashboard();
    api.getDashboard.mockResolvedValueOnce({
      ...summary,
      costs: {
        monthSpendMicros: 4_500,
        monthlyBudgetMicros: 0,
        totalInputTokens: 1040,
        totalOutputTokens: 110,
        totalTokens: 1150,
        unpricedRuns: 0,
        rates: [],
        mcpUsage: {
          calls: 2,
          inputTokens: 1040,
          outputTokens: 110,
          totalTokens: 1150,
          spendMicros: 4_500,
          unpricedCalls: 1,
          estimated: true,
          byTool: [
            { tool: 'brain_search', calls: 1, totalTokens: 1100 },
            { tool: 'issues_list', calls: 1, totalTokens: 50 },
          ],
          byClient: [{ provider: 'mcp', model: 'claude-code', calls: 2, totalTokens: 1150 }],
        },
      },
    });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="dashboard"
        currentUserId="user-a"
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Uso via MCP neste mês' });
    expect(screen.getByText(/Total de tokens usados: 1\.150/)).toBeInTheDocument();
    expect(panel).toHaveTextContent('Chamadas2');
    expect(panel).toHaveTextContent('Tokens≈ 1.150');
    expect(panel).toHaveTextContent(/Gasto\s*US\$\s*0,00/);
    expect(panel).toHaveTextContent('Entrada / saída: ≈ 1.040 / ≈ 110');
    expect(panel).toHaveTextContent('1 chamadas sem tarifa');
    expect(panel).toHaveTextContent('brain_search≈ 1.100 · 1×');
    expect(panel).toHaveTextContent('mcp / claude-code≈ 1.150 · 2×');
  });

  it('shows exact MCP usage without the estimate marker and an empty month', async () => {
    const api = client();
    const summary = await api.getDashboard();
    const costs = {
      monthSpendMicros: 0,
      monthlyBudgetMicros: 0,
      totalInputTokens: 30,
      totalOutputTokens: 0,
      totalTokens: 30,
      unpricedRuns: 0,
      rates: [],
    };
    const usage = {
      calls: 1,
      inputTokens: 30,
      outputTokens: 0,
      totalTokens: 30,
      spendMicros: 0,
      unpricedCalls: 0,
      estimated: false,
      byTool: [{ tool: 'spec_get', calls: 1, totalTokens: 30 }],
      byClient: [{ provider: 'mcp', model: 'codex', calls: 1, totalTokens: 30 }],
    };
    api.getDashboard.mockResolvedValueOnce({ ...summary, costs: { ...costs, mcpUsage: usage } });
    const { unmount } = render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="dashboard"
        currentUserId="user-a"
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Uso via MCP neste mês' });
    expect(panel).toHaveTextContent('Tokens30Gasto');
    expect(panel).toHaveTextContent('Entrada / saída: 30 / 0');
    expect(panel).not.toHaveTextContent('≈ 30');
    expect(panel).not.toHaveTextContent('sem tarifa');
    unmount();

    api.getDashboard.mockResolvedValueOnce({
      ...summary,
      costs: { ...costs, mcpUsage: { ...usage, calls: 0, byTool: [], byClient: [] } },
    });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="dashboard"
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText('Nenhum uso via MCP neste mês.')).toBeInTheDocument();
  });

  it('starts a new run for an assigned issue', async () => {
    const assigned = { ...issue, assigneeAgentId: 'agent-a' };
    const api = {
      ...client(),
      getAgentRuns: vi.fn().mockResolvedValue([]),
      startIssueRun: vi.fn().mockResolvedValue({ id: 'run-a' }),
    };
    api.getIssues.mockResolvedValue([assigned]);
    api.getIssue.mockResolvedValue({ issue: assigned, comments: [] });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Executar agente' }));
    await waitFor(() => expect(api.startIssueRun).toHaveBeenCalledWith(issue.id));
  });

  it('formats agent run output as rich content', async () => {
    const assigned = { ...issue, assigneeAgentId: 'agent-a' };
    const api = {
      ...client(),
      getAgentRuns: vi.fn().mockResolvedValue([
        {
          id: 'run-1',
          attempt: 1,
          status: 'succeeded',
          createdAt: issue.createdAt,
          costMicros: null,
          provider: null,
          output: '## Trabalho realizado\n\n- **36** casos\n\n```sql\nSELECT 1;\n```',
          error: null,
        },
      ]),
    };
    api.getIssues.mockResolvedValue([assigned]);
    api.getIssue.mockResolvedValue({ issue: assigned, comments: [] });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    expect(await screen.findByRole('heading', { name: 'Trabalho realizado' })).toBeInTheDocument();
    expect(screen.getByText('36').tagName).toBe('STRONG');
    expect(screen.getByText('sql')).toBeInTheDocument();
    expect(document.querySelector('.hljs-keyword')?.textContent).toBe('SELECT');
  });

  it('keeps comment focus while typing and submits the full message', async () => {
    const assigned = { ...issue, assigneeAgentId: 'agent-a' };
    const api = { ...client(), getAgentRuns: vi.fn().mockResolvedValue([]) };
    api.getIssues.mockResolvedValue([assigned]);
    api.getIssue.mockResolvedValue({ issue: assigned, comments: [] });
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    const input = await screen.findByRole('textbox', { name: 'Escreva um comentário...' });
    input.focus();
    fireEvent.change(input, { target: { value: 'P' } });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Please review' } });
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar comentário' }));
    await waitFor(() =>
      expect(api.addIssueComment).toHaveBeenCalledWith(issue.id, 'Please review'),
    );
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });
  it('shows dashboard figures from the API', async () => {
    const api = client();
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="dashboard"
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText('Agentes habilitados')).toBeInTheDocument();
    expect(screen.getByText('Issues por prioridade')).toBeInTheDocument();
    expect(screen.getAllByText('Prepare release').length).toBeGreaterThan(0);
  });

  it('switches the issues collection between list and board', async () => {
    const api = client();
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByRole('button', { name: '1 Prepare release' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quadro' }));
    expect(screen.getByRole('button', { name: 'Quadro' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Prepare release')).toBeInTheDocument();
  });

  it('filters issues by assignee and PBI iteration path and saves the filters', async () => {
    localStorage.clear();
    const other: Issue = {
      ...issue,
      id: 'issue-2',
      number: 2,
      title: 'Write docs',
      assigneeUserId: 'user-b',
      pbiItemId: 'task-1',
    };
    const api = {
      ...client(),
      getIssues: vi.fn().mockResolvedValue([issue, other]),
      getWorkspaceMembers: vi
        .fn()
        .mockResolvedValue([{ userId: 'user-b', user: { name: 'Bea', email: 'bea@x.dev' } }]),
      getPbiItems: vi.fn().mockResolvedValue([
        { id: 'pbi-1', parentId: null, sourceData: { iterationPath: 'Proj\\Sprint 9' } },
        { id: 'task-1', parentId: 'pbi-1', sourceData: {} },
      ]),
    };
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByRole('button', { name: '1 Prepare release' })).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Iteração' }), {
      target: { value: 'Proj\\Sprint 9' },
    });
    expect(screen.queryByRole('button', { name: '1 Prepare release' })).toBeNull();
    expect(screen.getByRole('button', { name: '2 Write docs' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), { target: { value: '' } });
    await screen.findByRole('option', { name: 'Bea' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Responsável' }), {
      target: { value: 'none' },
    });
    expect(screen.getByRole('button', { name: '1 Prepare release' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 Write docs' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do filtro' }), {
      target: { value: 'Sem dono' },
    });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Nome do filtro' }).closest('form')!);
    expect(screen.getByRole('option', { name: 'Sem dono' })).toHaveProperty('selected', true);

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(screen.getByRole('button', { name: '2 Write docs' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtros salvos' }), {
      target: { value: screen.getByRole('option', { name: 'Sem dono' }).getAttribute('value') },
    });
    expect(screen.queryByRole('button', { name: '2 Write docs' })).toBeNull();
    expect(
      JSON.parse(localStorage.getItem('adk:issue-saved-filters:workspace-a') ?? '[]'),
    ).toMatchObject([{ name: 'Sem dono', assignee: 'none' }]);
  });

  it('shows a loading failure and retries the requests', async () => {
    const api = client();
    api.getIssues.mockRejectedValueOnce(new Error('Unavailable'));
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: '1 Prepare release' })).toBeInTheDocument();
  });

  it('creates an issue from the sidebar request and marks opened inbox items as read', async () => {
    const api = client();
    const onNewIssueHandled = vi.fn();
    const view = render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="inbox"
        currentUserId="user-a"
        newIssueRequest={1}
        onNewIssueHandled={onNewIssueHandled}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Nova issue' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Título' }), {
      target: { value: 'Second issue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Criar issue' }));
    await waitFor(() =>
      expect(api.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Second issue' }),
      ),
    );
    expect(onNewIssueHandled).toHaveBeenCalled();
    view.rerender(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="inbox"
        currentUserId="user-a"
        newIssueRequest={0}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    await waitFor(() => expect(api.updateInboxItem).toHaveBeenCalledWith(issue.id, { read: true }));
    expect(await screen.findByText('Finish the checklist')).toBeInTheDocument();
  });
});

function accessWithIssues(level: ModuleAccess): EffectiveAccess {
  return { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, issues: level } };
}

describe('WorkView permissions', () => {
  it('hides the delete action from members who can only edit issues', async () => {
    const api = client();
    render(
      <PermissionsProvider access={accessWithIssues('edit')}>
        <WorkView
          apiClient={api as unknown as ApiClient}
          workspaceId="workspace-a"
          tab="issues"
          currentUserId="user-a"
        />
      </PermissionsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    expect(await screen.findByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adicionar comentário' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
  });

  it('lets members with delete access remove an issue', async () => {
    const api = { ...client(), deleteIssue: vi.fn().mockResolvedValue(undefined) };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <PermissionsProvider access={accessWithIssues('delete')}>
        <WorkView
          apiClient={api as unknown as ApiClient}
          workspaceId="workspace-a"
          tab="issues"
          currentUserId="user-a"
        />
      </PermissionsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(api.deleteIssue).toHaveBeenCalledWith(issue.id));
    confirm.mockRestore();
  });

  it('shows read-only members the issues without create, edit, comment or delete flows', async () => {
    const api = client();
    render(
      <PermissionsProvider access={accessWithIssues('view')}>
        <WorkView
          apiClient={api as unknown as ApiClient}
          workspaceId="workspace-a"
          tab="issues"
          currentUserId="user-a"
          isReadOnly
        />
      </PermissionsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    expect(await screen.findByText('Finish the checklist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nova issue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adicionar comentário' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar issues' }), {
      target: { value: 'nothing matches' },
    });
    expect(screen.getByText('Nenhuma issue encontrada.')).toBeInTheDocument();
    expect(screen.queryByText('Crie a primeira issue para começar.')).not.toBeInTheDocument();
  });

  it('invites editors to create the first issue when the list is empty', async () => {
    const api = client();
    api.getIssues.mockResolvedValue([]);
    render(
      <WorkView
        apiClient={api as unknown as ApiClient}
        workspaceId="workspace-a"
        tab="issues"
        currentUserId="user-a"
      />,
    );
    expect(await screen.findByText('Crie a primeira issue para começar.')).toBeInTheDocument();
  });
});
