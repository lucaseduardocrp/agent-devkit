import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { UserProfile } from '../src/features/auth/auth-types.js';
import type {
  ModuleAccessMap,
  UserWorkspaceMembership,
} from '../src/features/workspaces/workspace-types.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';

// The module screens are replaced by stand-ins that record the props the shell hands them, so the
// shell's own wiring (navigation, focus, permissions, workspaces) is what these tests exercise.
const views = vi.hoisted(() => ({ props: {} as Record<string, any> }));

vi.mock('../src/features/issues/WorkView.js', () => ({
  WorkView: (props: unknown) => {
    views.props['work'] = props;
    return <div data-testid="view-work" />;
  },
}));
vi.mock('../src/features/pbi/PbiView.js', () => ({
  PbiView: (props: unknown) => {
    views.props['pbis'] = props;
    return <div data-testid="view-pbis" />;
  },
}));
vi.mock('../src/features/brain/BrainView.js', () => ({
  BrainView: (props: unknown) => {
    views.props['brain'] = props;
    return <div data-testid="view-brain" />;
  },
}));
vi.mock('../src/features/agents/AgentsView.js', () => ({
  AgentsView: (props: unknown) => {
    views.props['agents'] = props;
    return <div data-testid="view-agents" />;
  },
}));
vi.mock('../src/features/testplans/TestPlansView.js', () => ({
  TestPlansView: (props: unknown) => {
    views.props['testplans'] = props;
    return <div data-testid="view-testplans" />;
  },
}));
vi.mock('../src/features/e2e/E2eView.js', () => ({
  E2eView: (props: unknown) => {
    views.props['e2e'] = props;
    return <div data-testid="view-e2e" />;
  },
}));
vi.mock('../src/features/e2e/E2eSourcesPage.js', () => ({
  E2eSourcesPage: (props: unknown) => {
    views.props['e2eSources'] = props;
    return <div data-testid="view-e2eSources" />;
  },
}));
vi.mock('../src/features/apitests/IntegrationTestsView.js', () => ({
  IntegrationTestsView: (props: unknown) => {
    views.props['integrationTests'] = props;
    return <div data-testid="view-integrationTests" />;
  },
}));
vi.mock('../src/features/apitests/LoadTestsView.js', () => ({
  LoadTestsView: (props: unknown) => {
    views.props['loadTests'] = props;
    return <div data-testid="view-loadTests" />;
  },
}));
vi.mock('../src/features/spec/SpecView.js', () => ({
  SpecView: (props: unknown) => {
    views.props['spec'] = props;
    return <div data-testid="view-spec" />;
  },
}));
vi.mock('../src/features/release-notes/ReleaseNotesView.js', () => ({
  ReleaseNotesView: (props: unknown) => {
    views.props['releaseNotes'] = props;
    return <div data-testid="view-releaseNotes" />;
  },
}));
vi.mock('../src/features/development/DevelopmentView.js', () => ({
  DevelopmentView: (props: unknown) => {
    views.props['development'] = props;
    return <div data-testid="view-development" />;
  },
}));
vi.mock('../src/features/design/DesignView.js', () => ({
  DesignView: (props: unknown) => {
    views.props['design'] = props;
    return <div data-testid="view-design" />;
  },
}));
vi.mock('../src/features/connect/ConnectView.js', () => ({
  ConnectView: (props: unknown) => {
    views.props['connect'] = props;
    return <div data-testid="view-connect" />;
  },
}));
vi.mock('../src/features/notifications/NotificationsView.js', () => ({
  NotificationsView: (props: unknown) => {
    views.props['notifications'] = props;
    return <div data-testid="view-notifications" />;
  },
}));
vi.mock('../src/features/workspaces/WorkspacesView.js', () => ({
  WorkspacesView: (props: unknown) => {
    views.props['workspaces'] = props;
    return <div data-testid="view-workspaces" />;
  },
}));
vi.mock('../src/features/settings/SettingsView.js', () => ({
  SettingsView: (props: unknown) => {
    views.props['settings'] = props;
    return <div data-testid="view-settings" />;
  },
}));

function membership(
  id: string,
  name: string,
  modules?: ModuleAccessMap,
  role: 'ADMIN' | 'MEMBER' = 'ADMIN',
): UserWorkspaceMembership {
  const base: UserWorkspaceMembership = {
    workspace: { id, name, slug: id, ownerId: 'usr-1', createdAt: '' },
    member: {
      id: `m-${id}`,
      workspaceId: id,
      userId: 'usr-1',
      role,
      permissions: {},
      createdAt: '',
    },
  };
  if (!modules) return base;
  const access = { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules } };
  for (const module of Object.keys(access.modules) as (keyof typeof access.modules)[])
    access.modules[module] = modules[module] ?? 'none';
  return { ...base, access };
}

const profile: UserProfile = {
  id: 'usr-1',
  email: 'ana@example.com',
  name: 'Ana',
  createdAt: '2026-09-11T12:00:00Z',
};

function makeClient(workspaces: readonly UserWorkspaceMembership[], user: UserProfile = profile) {
  const client = new ApiClient();
  vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'req-1' });
  vi.spyOn(client, 'getWorkspaces').mockResolvedValue([...workspaces]);
  vi.spyOn(client, 'getMe').mockResolvedValue(user);
  vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
  return client;
}

async function open(
  workspaces: readonly UserWorkspaceMembership[],
  tab: Parameters<typeof App>[0]['initialTab'] = 'brain',
  user: UserProfile = profile,
) {
  localStorage.setItem('adk_token', 'stored-token');
  const client = makeClient(workspaces, user);
  const view = render(<App apiClient={client} initialTab={tab} />);
  await waitFor(() => expect(client.getWorkspaceId()).toBe(workspaces[0]?.workspace.id ?? null));
  return { client, view };
}

const shown = (view: ReturnType<typeof render>, name: string) =>
  view.queryByTestId(`view-${name}`) !== null;

const call = (name: string, prop: string, ...args: unknown[]) =>
  act(() => {
    views.props[name][prop](...args);
  });

const full = [membership('ws-1', 'First'), membership('ws-2', 'Second')];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('adk_locale', 'pt-BR');
  views.props = {};
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('App sign-in from an OAuth redirect', () => {
  it('stores the token from the address, cleans the address and signs in with it', async () => {
    window.history.replaceState(null, '', '/path?x=1#oauth_token=from-oauth');
    const client = makeClient(full);
    const setToken = vi.spyOn(client, 'setToken');
    const view = render(<App apiClient={client} />);
    await waitFor(() => expect(shown(view, 'brain')).toBe(true));
    expect(localStorage.getItem('adk_token')).toBe('from-oauth');
    expect(setToken).toHaveBeenCalledWith('from-oauth');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
  });
});

describe('App references and focus', () => {
  it('goes to the module of a reference and opens that exact item', async () => {
    const { view } = await open(full, 'issues');
    expect(shown(view, 'work')).toBe(true);

    call('work', 'onOpenReference', { kind: 'pbi', ref: 'p1', excerpt: 'the passage' });
    expect(shown(view, 'pbis')).toBe(true);
    expect(views.props['pbis'].focus).toMatchObject({
      kind: 'pbi',
      ref: 'p1',
      excerpt: 'the passage',
    });

    // The opened item is handled once; a plain reference carries no excerpt.
    call('pbis', 'onFocusHandled');
    expect(views.props['pbis'].focus).toBeNull();
    call('pbis', 'onOpenIssues');
    expect(shown(view, 'work')).toBe(true);
    call('work', 'onOpenReference', { kind: 'brain', ref: 'page-1' });
    expect(views.props['brain'].focus).toEqual({
      kind: 'brain',
      ref: 'page-1',
      nonce: expect.any(Number),
    });
    call('brain', 'onFocusHandled');
    expect(views.props['brain'].focus).toBeNull();
  });

  it('ignores references to files and to modules the member cannot see', async () => {
    const restricted = [membership('ws-1', 'First', { issues: 'view', pbis: 'view' }, 'MEMBER')];
    const { view } = await open(restricted, 'issues');
    call('work', 'onOpenReference', { kind: 'file', ref: 'a.txt' });
    call('work', 'onOpenReference', { kind: 'spec', ref: 's1' });
    expect(shown(view, 'work')).toBe(true);
    expect(shown(view, 'spec')).toBe(false);
  });

  it('drops the pending item when the member moves to another module', async () => {
    const { view } = await open(full, 'issues');
    call('work', 'onOpenReference', { kind: 'pbi', ref: 'p1' });
    expect(views.props['pbis'].focus).not.toBeNull();
    call('pbis', 'onOpenTestPlans');
    expect(shown(view, 'testplans')).toBe(true);
    expect(views.props['testplans'].focus).toBeNull();
    call('testplans', 'onFocusHandled');
  });

  it('opens an issue from an agent run', async () => {
    const { view } = await open(full, 'agentsPlayground');
    expect(views.props['agents'].section).toBe('playground');
    call('agents', 'onSelectSection', 'workflow');
    expect(views.props['agents'].section).toBe('workflow');
    call('agents', 'onOpenIssue', 'issue-9');
    expect(shown(view, 'work')).toBe(true);
    expect(views.props['work'].focus).toMatchObject({ kind: 'issue', ref: 'issue-9' });
  });

  it('refreshes the PBI list after a change and leaves the dashboard for the issues', async () => {
    const { view } = await open(full, 'pbis');
    expect(views.props['pbis'].refreshToken).toBe(0);
    call('pbis', 'onPbiChanged');
    expect(views.props['pbis'].refreshToken).toBe(1);
    call('pbis', 'onOpenIssues');
    expect(shown(view, 'work')).toBe(true);
    expect(views.props['work'].tab).toBe('issues');
    call('work', 'onInboxCountChange', 3);
  });

  it('opens Issues from the dashboard', async () => {
    const { view } = await open(full, 'dashboard');
    expect(views.props['work'].tab).toBe('dashboard');
    call('work', 'onOpenIssues');
    expect(views.props['work'].tab).toBe('issues');
    expect(shown(view, 'work')).toBe(true);
    call('work', 'onFocusHandled');
  });

  it('hands Spec and Brain what they need to handle the focus', async () => {
    const { view } = await open(full, 'spec');
    expect(views.props['spec'].canManageTemplates).toBe(true);
    call('spec', 'onFocusHandled');
    expect(shown(view, 'spec')).toBe(true);
  });
});

describe('App test automation', () => {
  it('starts an E2E run from the cases chosen in Test Plans, once', async () => {
    const { view } = await open(full, 'testplans');
    expect(views.props['testplans'].onOpenIntegrations).toBeTypeOf('function');
    call('testplans', 'onAutomate', { suiteId: 's1', caseIds: ['c1'] });
    expect(shown(view, 'e2e')).toBe(true);
    expect(views.props['e2e'].initialSavedCases).toEqual({ suiteId: 's1', caseIds: ['c1'] });

    call('e2e', 'onOpenAgents');
    expect(shown(view, 'agents')).toBe(true);
    call('agents', 'onSelectSection', 'map');
    expect(views.props['agents'].section).toBe('map');
  });

  it('goes to Integrations from the E2E screen', async () => {
    const { view } = await open(full, 'e2e');
    expect(views.props['e2e'].initialSavedCases).toBeUndefined();
    call('e2e', 'onOpenIntegrations');
    expect(shown(view, 'connect')).toBe(true);
    expect(views.props['connect'].canManageIntegrations).toBe(true);
  });

  it('shows the Sources page', async () => {
    const { view } = await open(full, 'e2eSources');
    expect(shown(view, 'e2eSources')).toBe(true);
    expect(views.props['e2eSources'].isReadOnly).toBe(false);
  });

  it('shows the integration and load test screens', async () => {
    const { view } = await open(full, 'integrationTests');
    expect(views.props['integrationTests'].isReadOnly).toBe(false);
    call('integrationTests', 'onOpenIntegrations');
    expect(shown(view, 'connect')).toBe(true);
  });

  it('shows the load test screen', async () => {
    const { view } = await open(full, 'loadTests');
    expect(shown(view, 'loadTests')).toBe(true);
    expect(views.props['loadTests'].isReadOnly).toBe(false);
  });

  it('offers no automation or integrations shortcut without access to them', async () => {
    const restricted = [membership('ws-1', 'First', { testplans: 'edit', e2e: 'view' }, 'MEMBER')];
    const { view } = await open(restricted, 'testplans');
    expect(views.props['testplans'].onAutomate).toBeUndefined();
    expect(views.props['testplans'].onOpenIntegrations).toBeUndefined();
    expect(shown(view, 'testplans')).toBe(true);
  });
});

describe('App modules', () => {
  it('shows the Development screens as sections of one view', async () => {
    const { view } = await open(full, 'developmentCode');
    expect(views.props['development']).toMatchObject({
      workspaceId: 'ws-1',
      isReadOnly: false,
      section: 'code',
    });
    act(() => views.props['development'].onSelectSection('review'));
    expect(views.props['development'].section).toBe('review');
    expect(shown(view, 'development')).toBe(true);
  });

  it('shows release notes, design, notifications and workspaces', async () => {
    const { view } = await open(full, 'releaseNotes');
    expect(views.props['releaseNotes'].workspaceId).toBe('ws-1');
    expect(views.props['releaseNotes'].isReadOnly).toBe(false);
    view.unmount();

    const design = await open(full, 'design');
    expect(design.view.queryByTestId('view-design')).not.toBeNull();
    call('design', 'onManageRepositories');
    expect(shown(design.view, 'connect')).toBe(true);
    design.view.unmount();

    const notifications = await open(full, 'notifications');
    expect(views.props['notifications'].canManage).toBe(true);
    notifications.view.unmount();

    const workspaces = await open(full, 'workspaces');
    expect(views.props['workspaces'].workspaces).toHaveLength(2);
    workspaces.view.unmount();
  });

  it('falls back to the first module the member can see', async () => {
    const restricted = [membership('ws-1', 'First', { brain: 'view' }, 'MEMBER')];
    const { view } = await open(restricted, 'issues');
    expect(shown(view, 'brain')).toBe(true);
    expect(views.props['brain'].isReadOnly).toBe(true);
  });

  it('falls back to Settings when the member can see no module at all', async () => {
    const restricted = [membership('ws-1', 'First', {}, 'MEMBER')];
    const { view } = await open(restricted, 'issues');
    expect(shown(view, 'settings')).toBe(true);
  });

  it('shows the e-mail as the name of a user without one', async () => {
    const { view } = await open(full, 'brain', { ...profile, name: undefined } as UserProfile);
    expect(view.container.textContent).toContain('ana@example.com');
  });
});

describe('App workspaces', () => {
  it('renames a workspace in the list and keeps the others as they are', async () => {
    const { view } = await open(full, 'settings');
    expect(views.props['settings'].activeMembership.workspace.name).toBe('First');
    call('settings', 'onWorkspaceRenamed', { id: 'ws-1', name: 'Renamed' });
    expect(views.props['settings'].activeMembership.workspace.name).toBe('Renamed');
    call('settings', 'onWorkspaceRenamed', { id: 'ws-2', name: 'Other' });
    expect(views.props['settings'].activeMembership.workspace.name).toBe('Renamed');
    expect(shown(view, 'settings')).toBe(true);
  });

  it('keeps the active workspace when the session is checked again with a new client', async () => {
    localStorage.setItem('adk_token', 'stored-token');
    const first = makeClient(full);
    const view = render(<App apiClient={first} initialTab="brain" />);
    await waitFor(() => expect(first.getWorkspaceId()).toBe('ws-1'));
    call('brain', 'onFocusHandled');

    // A different client re-reads the workspaces: the active one is still in the list.
    const second = makeClient(full);
    view.rerender(<App apiClient={second} initialTab="brain" />);
    await waitFor(() => expect(second.getWorkspaces).toHaveBeenCalled());
    expect(second.getWorkspaceId()).toBeNull();

    // And when it is gone from the list, the first one takes its place.
    const third = makeClient([membership('ws-3', 'Third')]);
    view.rerender(<App apiClient={third} initialTab="brain" />);
    await waitFor(() => expect(third.getWorkspaceId()).toBe('ws-3'));
  });
});

describe('App before the member has a workspace', () => {
  it.each([
    'dashboard',
    'pbis',
    'e2e',
    'e2eSources',
    'integrationTests',
    'loadTests',
    'releaseNotes',
    'developmentPipeline',
    'notifications',
  ] as const)('shows %s with no active workspace', async (tab) => {
    const { view } = await open([], tab);
    expect(view.container.querySelector('[data-testid^="view-"]')).not.toBeNull();
  });
});
