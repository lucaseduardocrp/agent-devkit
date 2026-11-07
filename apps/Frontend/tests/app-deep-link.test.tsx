import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { UserProfile } from '../src/features/auth/auth-types.js';
import type {
  ModuleAccessMap,
  UserWorkspaceMembership,
} from '../src/features/workspaces/workspace-types.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';

function membership(id: string, name: string, userId: string): UserWorkspaceMembership {
  return {
    workspace: { id, name, slug: id, ownerId: userId, createdAt: '' },
    member: {
      id: `m-${id}`,
      workspaceId: id,
      userId,
      role: 'ADMIN',
      permissions: {},
      createdAt: '',
    },
  };
}

function withModules(
  item: UserWorkspaceMembership,
  modules: ModuleAccessMap,
): UserWorkspaceMembership {
  const access = { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules } };
  for (const module of Object.keys(access.modules) as (keyof typeof access.modules)[])
    access.modules[module] = modules[module] ?? 'none';
  return { ...item, member: { ...item.member, role: 'MEMBER' }, access };
}

const profile: UserProfile = {
  id: 'usr-1',
  email: 'ana@example.com',
  name: 'Ana',
  createdAt: '2026-09-11T12:00:00Z',
};

const now = '2026-01-01T00:00:00Z';
const issue = {
  id: 'issue-1',
  workspaceId: 'ws-2',
  number: 7,
  title: 'Approve exchanges',
  description: '',
  status: 'in_progress' as const,
  priority: 'medium' as const,
  assigneeAgentId: null,
  assigneeUserId: 'usr-1',
  createdBy: 'usr-1',
  createdAt: now,
  updatedAt: now,
};

/** A signed-in app whose workspaces are the given ones, opened from the given address. */
function open(workspaces: readonly UserWorkspaceMembership[], address: string) {
  window.history.replaceState(null, '', address);
  const client = new ApiClient();
  vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'req-1' });
  vi.spyOn(client, 'getWorkspaces').mockResolvedValue([...workspaces]);
  localStorage.setItem('adk_token', 'stored-token');
  vi.spyOn(client, 'getMe').mockResolvedValue(profile);
  vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
  vi.spyOn(client, 'getAgents').mockResolvedValue([]);
  vi.spyOn(client, 'getIssues').mockResolvedValue([issue]);
  vi.spyOn(client, 'getAgentRuns').mockResolvedValue([]);
  vi.spyOn(client, 'streamRunEvents').mockImplementation(() => new Promise(() => undefined));
  vi.spyOn(client, 'getInbox').mockResolvedValue([]);
  vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
  vi.spyOn(client, 'getPbiItems').mockResolvedValue([]);
  vi.spyOn(client, 'getDashboard').mockResolvedValue({
    agents: [],
    recentIssues: [],
    recentActivity: [],
    totalIssues: 1,
    inProgress: 1,
    open: 1,
    byStatus: {
      backlog: 0,
      todo: 0,
      in_progress: 1,
      in_review: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    },
    byPriority: { urgent: 0, high: 0, medium: 1, low: 0 },
  });
  vi.spyOn(client, 'getIssue').mockResolvedValue({ issue, comments: [] });
  vi.spyOn(client, 'updateInboxItem').mockResolvedValue(undefined);
  const view = render(<App apiClient={client} initialTab="brain" />);
  return { client, view };
}

describe('App notification links', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('adk_locale', 'pt-BR');
  });
  afterEach(() => window.history.replaceState(null, '', '/'));

  const both = [membership('ws-1', 'First', 'usr-1'), membership('ws-2', 'Second', 'usr-1')];

  it('opens the issue in the workspace the link names, and cleans the address', async () => {
    const { client } = open(both, '/?workspace=ws-2&issue=issue-1');

    await waitFor(() => expect(client.getIssue).toHaveBeenCalledWith('issue-1'));
    await waitFor(() => expect(client.getWorkspaceId()).toBe('ws-2'));
    expect(window.location.search).toBe('');
  });

  it('opens the issue in the current workspace when the link names none', async () => {
    const { client } = open(both, '/?issue=issue-1');

    await waitFor(() => expect(client.getIssue).toHaveBeenCalledWith('issue-1'));
    expect(client.getWorkspaceId()).toBe('ws-1');
    expect(window.location.search).toBe('');
  });

  it('does not take someone into a workspace they are not in, but drops the link', async () => {
    const { client, view } = open(both, '/?workspace=ws-other&issue=issue-1');

    await view.findAllByText('First');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  it('does not open an issue for someone who cannot see issues', async () => {
    const restricted = [withModules(membership('ws-2', 'Second', 'usr-1'), { brain: 'view' })];
    const { client, view } = open(restricted, '/?workspace=ws-2&issue=issue-1');

    await view.findAllByText('Second');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  it('leaves an address without an issue alone', async () => {
    const { client, view } = open(both, '/?workspace=ws-2');

    await view.findAllByText('First');
    expect(window.location.search).toBe('?workspace=ws-2');
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  it('shows the notifications screen, with its rules, from the menu', async () => {
    const { client, view } = open(both, '/');
    vi.spyOn(client, 'getNotificationChannels').mockResolvedValue([]);
    vi.spyOn(client, 'getNotificationEvents').mockResolvedValue([]);
    vi.spyOn(client, 'getNotificationRules').mockResolvedValue([]);
    (await view.findByTestId('sidebar-notifications-button')).click();

    expect(await view.findByTestId('screen-notifications')).toBeInTheDocument();
    expect(await view.findByText('Nenhuma regra ainda')).toBeInTheDocument();
  });
});
