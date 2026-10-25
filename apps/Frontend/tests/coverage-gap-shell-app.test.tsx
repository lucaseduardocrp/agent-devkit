import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { UserProfile } from '../src/features/auth/auth-types.js';
import type { UserWorkspaceMembership } from '../src/features/workspaces/workspace-types.js';

// The feature views are replaced by stubs exposing their callbacks as buttons, so these tests
// check only how the shell wires navigation and shared state between them.
const { stub } = await vi.hoisted(async () => {
  const React = await import('react');
  const args: Record<string, unknown> = {
    onWorkspaceRenamed: { id: 'ws-1', name: 'Renamed Corp' },
    onSelectWorkspace: 'ws-2',
    onAutomate: { source: 'saved', suiteId: 's1' },
  };
  const stub =
    (name: string) =>
    (props: Record<string, unknown>): unknown => {
      const membership = props.activeMembership as { workspace: { name: string } } | undefined;
      return React.createElement(
        'section',
        { 'data-testid': `stub-${name}` },
        React.createElement(
          'output',
          { 'aria-label': `${name} state` },
          JSON.stringify({
            tab: props.tab,
            workspaceId: 'workspaceId' in props ? props.workspaceId : props.activeWorkspaceId,
            refreshToken: props.refreshToken,
            currentUserId: props.currentUserId,
            workspace: membership?.workspace.name,
          }),
        ),
        ...Object.entries(props)
          .filter(([, value]) => typeof value === 'function')
          .map(([key, value]) =>
            React.createElement(
              'button',
              { key, type: 'button', onClick: () => (value as (arg: unknown) => void)(args[key]) },
              `${name}.${key}`,
            ),
          ),
      );
    };
  return { stub };
});

vi.mock('../src/features/issues/WorkView.js', () => ({ WorkView: stub('WorkView') }));
vi.mock('../src/features/pbi/PbiView.js', () => ({ PbiView: stub('PbiView') }));
vi.mock('../src/features/brain/BrainView.js', () => ({ BrainView: stub('BrainView') }));
vi.mock('../src/features/agents/AgentsView.js', () => ({ AgentsView: stub('AgentsView') }));
vi.mock('../src/features/testplans/TestPlansView.js', () => ({
  TestPlansView: stub('TestPlansView'),
}));
vi.mock('../src/features/spec/SpecView.js', () => ({ SpecView: stub('SpecView') }));
vi.mock('../src/features/release-notes/ReleaseNotesView.js', () => ({
  ReleaseNotesView: stub('ReleaseNotesView'),
}));
vi.mock('../src/features/connect/ConnectView.js', () => ({ ConnectView: stub('ConnectView') }));
vi.mock('../src/features/settings/SettingsView.js', () => ({
  SettingsView: stub('SettingsView'),
}));
vi.mock('../src/features/design/DesignView.js', () => ({ DesignView: stub('DesignView') }));
vi.mock('../src/features/e2e/E2eView.js', () => ({ E2eView: stub('E2eView') }));
vi.mock('../src/features/apitests/IntegrationTestsView.js', () => ({
  IntegrationTestsView: stub('IntegrationTestsView'),
}));
vi.mock('../src/features/apitests/LoadTestsView.js', () => ({
  LoadTestsView: stub('LoadTestsView'),
}));

function membership(id: string, name: string): UserWorkspaceMembership {
  return {
    workspace: { id, name, slug: id, ownerId: 'usr-1', createdAt: '' },
    member: {
      id: `m-${id}`,
      workspaceId: id,
      userId: 'usr-1',
      role: 'ADMIN',
      permissions: {},
      createdAt: '',
    },
  };
}

const ana: UserProfile = { id: 'usr-1', name: 'Ana', email: 'ana@example.com', createdAt: '' };

function sessionClient(workspaces: readonly UserWorkspaceMembership[]): ApiClient {
  const client = new ApiClient();
  vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'req-1' });
  vi.spyOn(client, 'getWorkspaces').mockResolvedValue([...workspaces]);
  vi.spyOn(client, 'getMe').mockResolvedValue(ana);
  return client;
}

const state = (name: string) =>
  JSON.parse(screen.getByRole('status', { name: `${name} state` }).textContent ?? '{}') as Record<
    string,
    unknown
  >;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('adk_locale', 'pt-BR');
  localStorage.setItem('adk_token', 'stored-token');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('App shell wiring', () => {
  it('signs in with the token handed back by OAuth and removes it from the address', async () => {
    localStorage.removeItem('adk_token');
    window.history.replaceState(null, '', '/app?x=1#oauth_token=oauth-jwt');
    const client = sessionClient([membership('ws-1', 'Primary Corp')]);
    const setToken = vi.spyOn(client, 'setToken');

    render(<App apiClient={client} initialTab="brain" />);

    expect(await screen.findByTestId('stub-BrainView')).toBeInTheDocument();
    expect(localStorage.getItem('adk_token')).toBe('oauth-jwt');
    expect(setToken).toHaveBeenCalledWith('oauth-jwt');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/app?x=1');
  });

  it('moves between PBIs, Issues and Test Plans and refreshes PBIs when one changes', async () => {
    const client = sessionClient([membership('ws-1', 'Primary Corp')]);
    render(<App apiClient={client} initialTab="pbis" />);

    await screen.findByTestId('stub-PbiView');
    await waitFor(() => expect(state('PbiView').workspaceId).toBe('ws-1'));
    expect(state('PbiView').refreshToken).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'PbiView.onPbiChanged' }));
    expect(state('PbiView').refreshToken).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'PbiView.onOpenTestPlans' }));
    expect(screen.getByTestId('stub-TestPlansView')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'TestPlansView.onOpenIntegrations' }));
    expect(screen.getByTestId('stub-ConnectView')).toBeInTheDocument();
  });

  it('opens Issues from the PBIs and from the dashboard', async () => {
    const client = sessionClient([membership('ws-1', 'Primary Corp')]);
    const view = render(<App apiClient={client} initialTab="pbis" />);

    fireEvent.click(await screen.findByRole('button', { name: 'PbiView.onOpenIssues' }));
    expect(state('WorkView')).toMatchObject({ tab: 'issues', currentUserId: 'usr-1' });
    view.unmount();

    render(<App apiClient={client} initialTab="dashboard" />);
    await waitFor(() => expect(state('WorkView').tab).toBe('dashboard'));
    fireEvent.click(screen.getByRole('button', { name: 'WorkView.onOpenIssues' }));
    expect(state('WorkView').tab).toBe('issues');
  });

  it('shows the API test, release notes and design views and links design to Connect', async () => {
    const client = sessionClient([membership('ws-1', 'Primary Corp')]);
    const tabs = ['integrationTests', 'loadTests', 'releaseNotes'] as const;
    const names = ['IntegrationTestsView', 'LoadTestsView', 'ReleaseNotesView'];
    for (const [index, tab] of tabs.entries()) {
      const view = render(<App apiClient={client} initialTab={tab} />);
      expect(await screen.findByTestId(`stub-${names[index]}`)).toBeInTheDocument();
      view.unmount();
    }

    render(<App apiClient={client} initialTab="design" />);
    fireEvent.click(await screen.findByRole('button', { name: 'DesignView.onManageRepositories' }));
    expect(screen.getByTestId('stub-ConnectView')).toBeInTheDocument();
  });

  it('renames only the active workspace when Settings reports a new name', async () => {
    const client = sessionClient([membership('ws-1', 'Primary Corp'), membership('ws-2', 'Other')]);
    render(<App apiClient={client} initialTab="settings" />);

    await waitFor(() => expect(state('SettingsView').workspace).toBe('Primary Corp'));
    fireEvent.click(screen.getByRole('button', { name: 'SettingsView.onWorkspaceRenamed' }));
    expect(state('SettingsView').workspace).toBe('Renamed Corp');
    expect(screen.getAllByText('Renamed Corp').length).toBeGreaterThan(0);
    expect(screen.queryByText('Primary Corp')).not.toBeInTheDocument();
  });

  it('keeps the chosen workspace when the session is checked again with a new client', async () => {
    const first = sessionClient([membership('ws-1', 'Primary Corp'), membership('ws-2', 'Other')]);
    const view = render(<App apiClient={first} initialTab="testplans" />);
    await waitFor(() => expect(state('TestPlansView').workspaceId).toBe('ws-1'));
    fireEvent.click(screen.getByRole('button', { name: 'TestPlansView.onSelectWorkspace' }));
    expect(state('TestPlansView').workspaceId).toBe('ws-2');

    const second = sessionClient([membership('ws-1', 'Primary Corp'), membership('ws-2', 'Other')]);
    const setWorkspaceId = vi.spyOn(second, 'setWorkspaceId');
    view.rerender(<App apiClient={second} initialTab="testplans" />);

    await waitFor(() => expect(second.getWorkspaces).toHaveBeenCalled());
    expect(state('TestPlansView').workspaceId).toBe('ws-2');
    expect(setWorkspaceId).not.toHaveBeenCalled();
  });

  it('keys the workspace views without a workspace and links E2E to Agents and Connect', async () => {
    const client = sessionClient([]);
    const tabs = {
      dashboard: 'WorkView',
      pbis: 'PbiView',
      integrationTests: 'IntegrationTestsView',
      loadTests: 'LoadTestsView',
      releaseNotes: 'ReleaseNotesView',
    } as const;
    for (const [tab, name] of Object.entries(tabs)) {
      const view = render(<App apiClient={client} initialTab={tab as keyof typeof tabs} />);
      expect(await screen.findByTestId(`stub-${name}`)).toBeInTheDocument();
      view.unmount();
    }

    render(<App apiClient={client} initialTab="e2e" />);
    fireEvent.click(await screen.findByRole('button', { name: 'E2eView.onOpenAgents' }));
    expect(screen.getByTestId('stub-AgentsView')).toBeInTheDocument();
  });

  it('opens E2E from Test Plans automation and from E2E reaches Connect', async () => {
    const client = sessionClient([membership('ws-1', 'Primary Corp')]);
    render(<App apiClient={client} initialTab="testplans" />);

    fireEvent.click(await screen.findByRole('button', { name: 'TestPlansView.onAutomate' }));
    expect(screen.getByTestId('stub-E2eView')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'E2eView.onOpenIntegrations' }));
    expect(screen.getByTestId('stub-ConnectView')).toBeInTheDocument();
  });

  it('offers no automation or integrations link in Test Plans to a viewer', async () => {
    const viewer = membership('ws-1', 'Primary Corp');
    const client = sessionClient([{ ...viewer, member: { ...viewer.member, role: 'VIEWER' } }]);
    render(<App apiClient={client} initialTab="testplans" />);

    await waitFor(() => expect(state('TestPlansView').workspaceId).toBe('ws-1'));
    expect(screen.queryByRole('button', { name: 'TestPlansView.onAutomate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'TestPlansView.onOpenIntegrations' })).toBeNull();
  });
});
