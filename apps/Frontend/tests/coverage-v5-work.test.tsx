import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkView } from '../src/features/issues/WorkView.js';
import type { Issue } from '../src/features/issues/issue-types.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';
import { ApiClient } from '../src/lib/api-client.js';

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

const pbi = (id: string, iterationPath: string) =>
  ({ id, parentId: null, sourceData: { iterationPath } }) as unknown as PbiItem;

function createApi(issues: Issue[], pbis: Promise<PbiItem[]>) {
  const api = new ApiClient();
  vi.spyOn(api, 'getIssues').mockResolvedValue(issues);
  vi.spyOn(api, 'getInbox').mockResolvedValue([]);
  vi.spyOn(api, 'getDashboard').mockResolvedValue({
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
  });
  vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue([]);
  const getPbiItems = vi.spyOn(api, 'getPbiItems').mockReturnValue(pbis);
  const getIssue = vi.spyOn(api, 'getIssue').mockImplementation(async (id: string) => ({
    issue: issues.find((issue) => issue.id === id) ?? issues[0]!,
    comments: [],
  }));
  vi.spyOn(api, 'getAuditHistory').mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    totalPages: 1,
  });
  return { api, getPbiItems, getIssue };
}

afterEach(() => vi.restoreAllMocks());

describe('WorkView coverage (Vitest 5)', () => {
  it('sorts the iterations of several PBIs', async () => {
    const issues = [
      makeIssue({ pbiItemId: 'b' }),
      makeIssue({ id: 'issue-2', number: 2, title: 'Second', pbiItemId: 'a' }),
    ];
    const { api } = createApi(
      issues,
      Promise.resolve([pbi('b', 'Proj\\Sprint 2'), pbi('a', 'Proj\\Sprint 1')]),
    );
    render(<WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" />);
    const iteration = await screen.findByRole('combobox', { name: 'Iteração' });
    expect(
      within(iteration)
        .getAllByRole('option')
        .slice(1)
        .map((option) => option.textContent),
    ).toEqual(['Proj\\Sprint 1', 'Proj\\Sprint 2']);
  });

  it('drops PBI iterations that arrive after unmounting', async () => {
    let finish!: (items: PbiItem[]) => void;
    const { api, getPbiItems } = createApi(
      [makeIssue()],
      new Promise((resolve) => (finish = resolve)),
    );
    const view = render(
      <WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" />,
    );
    await waitFor(() => expect(getPbiItems).toHaveBeenCalled());
    view.unmount();
    await act(async () => finish([pbi('a', 'Proj\\Sprint 1')]));
  });

  it('polls only comments when the client cannot list agent runs', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { api, getIssue } = createApi([makeIssue()], Promise.resolve([]));
    Object.defineProperty(api, 'getAgentRuns', { value: undefined });
    render(<WorkView apiClient={api} workspaceId="ws" tab="issues" currentUserId="user-a" />);
    fireEvent.click(await screen.findByRole('button', { name: '1 Prepare release' }));
    await screen.findByRole('dialog');
    const poll = setIntervalSpy.mock.calls.find(([, delay]) => delay === 5000)![0];
    const calls = getIssue.mock.calls.length;
    await act(async () => poll());
    expect(getIssue.mock.calls.length).toBe(calls + 1);
  });
});
