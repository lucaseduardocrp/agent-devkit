import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkView } from '../src/features/issues/WorkView.js';
import type { Issue } from '../src/features/issues/issue-types.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';
import { ApiClient } from '../src/lib/api-client.js';

const NOW = new Date().toISOString();
const DRAFT_KEY = 'adk:kanban-draft:issues:ws';

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: 'i1',
    workspaceId: 'ws',
    number: 1,
    title: 'Typed card',
    description: 'd',
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

function makeMember(userId: string, name: string): WorkspaceMember {
  return {
    id: `m-${userId}`,
    workspaceId: 'ws',
    userId,
    role: 'MEMBER',
    permissions: {},
    createdAt: NOW,
    user: { id: userId, name, email: `${userId}@example.com` },
  };
}

const issues: Issue[] = [
  makeIssue({ id: 'i1', number: 1, title: 'Typed card', type: 'bug', assigneeUserId: 'u-bia' }),
  makeIssue({ id: 'i2', number: 2, title: 'Orphan card', assigneeUserId: 'u-gone' }),
  makeIssue({ id: 'i3', number: 3, title: 'Blocked card', status: 'blocked' }),
];

function createApi() {
  const api = new ApiClient();
  const spies = {
    getIssues: vi.spyOn(api, 'getIssues').mockResolvedValue(issues),
    getInbox: vi.spyOn(api, 'getInbox').mockResolvedValue([]),
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
    getWorkspaceMembers: vi
      .spyOn(api, 'getWorkspaceMembers')
      .mockResolvedValue([makeMember('u-zed', 'Zed'), makeMember('u-bia', 'Bia')]),
    getPbiItems: vi.spyOn(api, 'getPbiItems').mockResolvedValue([]),
    getWorkItemTypes: vi.spyOn(api, 'getWorkItemTypes').mockResolvedValue([
      { key: 'bug', label: 'Bug', color: 'red', icon: 'bug', aliases: [] },
      { key: 'task', label: 'Task', color: '#123456', icon: 'checklist', aliases: [] },
    ]),
    getIssue: vi.spyOn(api, 'getIssue').mockImplementation(async (id: string) => ({
      issue: issues.find((issue) => issue.id === id) ?? issues[0]!,
      comments: [],
    })),
    getAgentRuns: vi.spyOn(api, 'getAgentRuns').mockResolvedValue([]),
    updateIssue: vi.spyOn(api, 'updateIssue').mockResolvedValue(issues[0]!),
    getAuditHistory: vi
      .spyOn(api, 'getAuditHistory')
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 1 }),
  };
  return { api, spies };
}

const renderView = (api: ApiClient) =>
  render(<WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" />);

function dragData() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
  };
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('WorkView typed issues', () => {
  it('shows the type badge in the list and sorts members in the assignee filter', async () => {
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Typed card' });
    expect(screen.getAllByText('Bug').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Filtros/ }));
    const select = await screen.findByRole('combobox', { name: 'Responsável' });
    await waitFor(() => expect(within(select).queryByRole('option', { name: 'Bia' })).not.toBeNull());
    const labels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels.indexOf('Bia')).toBeLessThan(labels.indexOf('Zed'));
  });

  it('shows type, assignee and drag feedback on the board cards', async () => {
    const { api } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Typed card' });
    await waitFor(() => expect(api.getWorkspaceMembers).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    const card = (await screen.findByText('Typed card')).closest('[draggable]') as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain('Bia'));
    expect(card.textContent).toContain('Bug');
    const orphan = screen.getByText('Orphan card').closest('[draggable]') as HTMLElement;
    expect(orphan.textContent).not.toContain('Bia');

    const dataTransfer = dragData();
    const blocked = screen.getByText('Blocked card').closest('section') as HTMLElement;
    const todo = card.closest('section') as HTMLElement;
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(blocked, { dataTransfer });
    // Leaving a column that is not the current target keeps the current one.
    const leave = createEvent.dragLeave(todo);
    fireEvent(todo, leave);
    expect(screen.queryByTestId('kanban-drop-placeholder')).not.toBeNull();
  });

  it('marks a card as saving while its move is being sent', async () => {
    const { api, spies } = createApi();
    spies.updateIssue.mockReturnValue(new Promise(() => undefined));
    renderView(api);
    await screen.findByRole('button', { name: '1 Typed card' });
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    const card = (await screen.findByText('Typed card')).closest('[draggable]') as HTMLElement;
    const blocked = screen.getByText('Blocked card').closest('section') as HTMLElement;
    const dataTransfer = dragData();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(blocked, { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar agora' }));
    await waitFor(() => expect(spies.updateIssue).toHaveBeenCalled());
    expect(await screen.findByTestId('kanban-card-saving')).not.toBeNull();
  });

  it('ignores a stored draft of an issue that no longer exists', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ghost: { from: 'todo', to: 'done' } }));
    const { api } = createApi();
    renderView(api);
    expect(await screen.findByRole('button', { name: '1 Typed card' })).not.toBeNull();
  });

  it('changes the type in the create form and in the issue detail', async () => {
    const { api, spies } = createApi();
    renderView(api);
    await screen.findByRole('button', { name: '1 Typed card' });
    fireEvent.click(screen.getByRole('button', { name: 'Nova issue' }));
    const form = screen.getByRole('dialog');
    fireEvent.change(within(form).getByRole('combobox', { name: 'Tipo' }), {
      target: { value: 'task' },
    });
    expect((within(form).getByRole('combobox', { name: 'Tipo' }) as HTMLSelectElement).value).toBe(
      'task',
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '1 Typed card' }));
    const detail = await screen.findByRole('dialog');
    const type = await within(detail).findByRole('combobox', { name: 'Tipo' });
    fireEvent.change(type, { target: { value: 'task' } });
    await waitFor(() => expect(spies.updateIssue).toHaveBeenCalledWith('i1', { type: 'task' }));
  });
});
