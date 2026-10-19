import { fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { UserProfile } from '../src/features/auth/auth-types.js';
import type {
  ModuleAccessMap,
  UserWorkspaceMembership,
} from '../src/features/workspaces/workspace-types.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';

type Role = UserWorkspaceMembership['member']['role'];

function membership(
  id: string,
  name: string,
  userId: string,
  role: Role = 'ADMIN',
  permissions: UserWorkspaceMembership['member']['permissions'] = {},
): UserWorkspaceMembership {
  return {
    workspace: { id, name, slug: id, ownerId: userId, createdAt: '' },
    member: { id: `m-${id}`, workspaceId: id, userId, role, permissions, createdAt: '' },
  };
}

function user(id: string, name: string | undefined, email: string): UserProfile {
  return { id, email, ...(name ? { name } : {}), createdAt: '2026-09-11T12:00:00Z' };
}

function clientFor(workspaces: readonly UserWorkspaceMembership[] | Error = []): ApiClient {
  const client = new ApiClient();
  vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'req-1' });
  vi.spyOn(client, 'getWorkspaces').mockImplementation(() =>
    workspaces instanceof Error ? Promise.reject(workspaces) : Promise.resolve([...workspaces]),
  );
  return client;
}

/** Starts the app with a stored session, as after a previous login. */
function withSession(client: ApiClient, profile: UserProfile): void {
  localStorage.setItem('adk_token', 'stored-token');
  vi.spyOn(client, 'getMe').mockResolvedValue(profile);
}

/** Signs in through the login screen that guards the whole application. */
async function signIn(view: RenderResult, client: ApiClient, profile: UserProfile) {
  vi.spyOn(client, 'login').mockResolvedValue({ token: `jwt-${profile.id}`, user: profile });
  fireEvent.change(await view.findByLabelText('E-mail'), { target: { value: profile.email } });
  fireEvent.change(view.getByLabelText('Senha'), { target: { value: 'secretPass123' } });
  fireEvent.click(view.getByRole('button', { name: 'Entrar na Plataforma' }));
  await waitFor(() => expect(view.queryByTestId('auth-modal')).not.toBeInTheDocument());
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('adk_locale', 'pt-BR');
  });

  it('asks for a login before showing the application', async () => {
    const client = clientFor();
    const view = render(<App apiClient={client} initialTab="connect" />);

    expect(await view.findByTestId('auth-modal')).toBeInTheDocument();
    expect(view.queryByTestId('screen-connect')).not.toBeInTheDocument();
    expect(view.queryByRole('heading', { level: 1, name: 'Aplicação' })).not.toBeInTheDocument();
    await waitFor(() => expect(client.getHealth).toHaveBeenCalled());
  });

  it('renders the login screen with default props without crashing', () => {
    const view = render(<App />);
    expect(view.getByTestId('auth-modal')).toBeInTheDocument();
  });

  it('handles backend connection failure while checking the session', async () => {
    const client = new ApiClient();
    const getHealthSpy = vi
      .spyOn(client, 'getHealth')
      .mockRejectedValue(new Error('Network error'));

    render(<App apiClient={client} />);

    await waitFor(() => {
      expect(getHealthSpy).toHaveBeenCalled();
    });
  });

  it('shows the checking state until the stored session is verified', async () => {
    const client = clientFor();
    localStorage.setItem('adk_token', 'stored-token');
    let resolve!: (value: UserProfile) => void;
    vi.spyOn(client, 'getMe').mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<App apiClient={client} />);
    expect(view.getByTestId('auth-session-loading')).toHaveAttribute(
      'aria-label',
      'Verificando sua sessão...',
    );
    resolve(user('usr-1', 'Ana', 'ana@example.com'));
    expect(await view.findByTestId('screen-brain')).toBeInTheDocument();
  });

  it('allows navigating across all application views', async () => {
    const client = clientFor([membership('ws-1', 'Primary Corp', 'usr-1')]);
    withSession(client, user('usr-1', 'Ana', 'ana@example.com'));
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecifications').mockResolvedValue([]);

    const view = render(<App apiClient={client} initialTab="brain" />);

    expect(await view.findByTestId('screen-brain')).toBeInTheDocument();
    expect(view.getByRole('heading', { level: 1, name: 'Aplicação' })).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: /^Test$/i }));
    fireEvent.click(view.getByRole('button', { name: 'Planos de Teste' }));
    expect(view.getByTestId('screen-testplans')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: /Integrações/i }));
    expect(view.getByTestId('screen-connect')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    expect(view.getByTestId('screen-settings')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Agents' }));
    expect(view.getByTestId('agents-view')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Product' }));
    fireEvent.click(view.getByRole('button', { name: 'Spec' }));
    expect(view.getByTestId('screen-spec')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Brain' }));
    expect(view.getByTestId('screen-brain')).toBeInTheDocument();
  });

  it('opens a new E2E run for saved test cases chosen in Test Plans', async () => {
    const client = clientFor([membership('ws-1', 'Primary Corp', 'usr-1')]);
    withSession(client, user('usr-1', 'Ana', 'ana@example.com'));
    const suite = {
      id: 's1',
      workspaceId: 'ws-1',
      name: 'Sprint 10',
      createdAt: '',
      updatedAt: '',
    };
    vi.spyOn(client, 'getTestSuites').mockResolvedValue([suite]);
    vi.spyOn(client, 'getSavedTestPlans').mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 8,
      total: 0,
      totalPages: 0,
    });
    vi.spyOn(client, 'getAllSavedTestPlans').mockResolvedValue([]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getAzureDevOpsProjectMembers').mockResolvedValue({
      configured: false,
      organization: null,
      project: null,
      members: [],
    });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(client, 'getE2eCreations').mockResolvedValue([]);
    vi.spyOn(client, 'getE2eRunners').mockResolvedValue([]);
    vi.spyOn(client, 'getE2eRepositories').mockResolvedValue({ repositories: [], warnings: [] });
    vi.spyOn(client, 'getTestManagementProviders').mockResolvedValue([]);
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });

    const view = render(<App apiClient={client} initialTab="testplans" />);
    fireEvent.click(await view.findByRole('button', { name: 'Ações: Sprint 10' }));
    fireEvent.click(view.getByRole('button', { name: 'Automatizar com E2E' }));
    expect(await view.findByRole('radio', { name: 'Test cases salvos no ADK' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Coming back to E2E later shows the list instead of the form.
    fireEvent.click(view.getByRole('button', { name: 'Planos de Teste' }));
    fireEvent.click(view.getByRole('button', { name: 'E2E Automation' }));
    await waitFor(() => expect(client.getE2eCreations).toHaveBeenCalled());
    expect(view.queryByRole('radio', { name: 'Test cases salvos no ADK' })).toBeNull();

    // The import window links to the integrations.
    fireEvent.click(view.getByRole('button', { name: 'Planos de Teste' }));
    fireEvent.click(await view.findByTestId('btn-import-from-provider'));
    fireEvent.click(await view.findByRole('button', { name: 'Configurar integrações' }));
    expect(await view.findByTestId('screen-connect')).toBeInTheDocument();
  });

  it('restores authenticated user profile from stored session token on mount', async () => {
    const client = clientFor([membership('usr-123', 'WS 123', 'usr-123')]);
    withSession(client, user('usr-123', 'Stored User', 'stored@example.com'));
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecTemplates').mockResolvedValue([]);
    vi.spyOn(client, 'getSpecifications').mockResolvedValue([]);

    const { getAllByText, getByRole, getByTestId } = render(<App apiClient={client} />);

    await waitFor(() => {
      expect(getAllByText('Stored User').length).toBeGreaterThan(0);
      expect(getAllByText('SU').length).toBeGreaterThan(0);
    });

    fireEvent.click(getByRole('button', { name: 'Spec' }));
    await waitFor(() => expect(getByTestId('screen-spec')).toBeInTheDocument());
    fireEvent.click(
      within(getByTestId('screen-spec')).getByRole('button', { name: 'Configurações' }),
    );
    fireEvent.click(within(getByTestId('screen-spec')).getByRole('button', { name: 'Ações' }));
    expect(getByRole('button', { name: 'Novo template' })).toBeInTheDocument();

    // Navigate to settings in the same app
    fireEvent.click(getByTestId('sidebar-settings-footer-button'));
    await waitFor(() => {
      expect(getByTestId('screen-settings')).toBeInTheDocument();
      expect(getAllByText('usr-123').length).toBeGreaterThan(0);
    });
  });

  it('clears stored session token if profile verification fails on mount', async () => {
    localStorage.setItem('adk_token', 'expired-token');
    const client = new ApiClient();
    vi.spyOn(client, 'getHealth').mockResolvedValue({ status: 'ok', requestId: 'req-1' });
    vi.spyOn(client, 'getMe').mockRejectedValue(new Error('Session expired'));

    const view = render(<App apiClient={client} />);

    await waitFor(() => {
      expect(localStorage.getItem('adk_token')).toBeNull();
      expect(client.getToken()).toBeNull();
    });
    expect(await view.findByTestId('auth-modal')).toBeInTheDocument();
  });

  it('authenticates through the login screen and returns to it on logout', async () => {
    const client = clientFor();
    vi.spyOn(client, 'logout').mockResolvedValue();
    const view = render(<App apiClient={client} />);

    await signIn(view, client, user('usr-fresh', 'Fresh User', 'fresh@example.com'));
    expect(view.getAllByText('Fresh User').length).toBeGreaterThan(0);
    expect(localStorage.getItem('adk_token')).toBe('jwt-usr-fresh');

    fireEvent.click(view.getByRole('button', { name: 'Perfil: Fresh User' }));
    fireEvent.click(view.getByTestId('topbar-menu-logout'));

    await waitFor(() => {
      expect(client.logout).toHaveBeenCalled();
      expect(localStorage.getItem('adk_token')).toBeNull();
      expect(view.getByTestId('auth-modal')).toBeInTheDocument();
    });
    expect(client.getWorkspaceId()).toBeNull();
  });

  it('shows the user email when the profile has no name', async () => {
    const client = clientFor();
    const view = render(<App apiClient={client} />);

    await signIn(view, client, user('usr-email-only', undefined, 'emailonly@example.com'));

    expect(view.getAllByText('emailonly@example.com').length).toBeGreaterThan(0);
    expect(view.getByRole('button', { name: 'Perfil: emailonly@example.com' })).toHaveTextContent(
      'EM',
    );
  });

  it('loads workspaces on login, allows creating and switching workspaces, and opens members management', async () => {
    const primary = membership('ws-1', 'Primary Corp', 'usr-admin', 'ADMIN', {
      canManageMembers: true,
    });
    const secondary = membership('ws-2', 'Secondary Team', 'usr-admin', 'VIEWER');
    const client = clientFor([primary, secondary]);
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([primary.member]);
    vi.spyOn(client, 'createWorkspace').mockResolvedValue(
      membership('ws-3', 'Created Workspace', 'usr-admin'),
    );

    const view = render(<App apiClient={client} initialTab="brain" />);
    await signIn(view, client, user('usr-admin', 'Admin User', 'admin@corp.com'));

    expect(await view.findByText('Primary Corp')).toBeInTheDocument();
    expect(client.getWorkspaceId()).toBe('ws-1');

    fireEvent.click(view.getByTestId('sidebar-workspaces-button'));
    fireEvent.click(view.getByRole('button', { name: 'Selecionar workspace Secondary Team' }));
    expect(client.getWorkspaceId()).toBe('ws-2');

    fireEvent.change(view.getByLabelText(/nome do workspace/i), {
      target: { value: 'Created Workspace' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Criar Workspace' }));
    await waitFor(() => expect(client.getWorkspaceId()).toBe('ws-3'));

    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    expect(view.getByTestId('workspace-members-management')).toBeInTheDocument();
  });

  function withGroups(item: UserWorkspaceMembership, modules: ModuleAccessMap) {
    const access = { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules } };
    for (const module of Object.keys(access.modules) as (keyof typeof access.modules)[])
      access.modules[module] = modules[module] ?? 'none';
    return {
      ...item,
      access: { ...access, workspace: { ...access.workspace, manageCosts: false } },
    };
  }

  it('keeps Brain read-only when the member groups only allow viewing it', async () => {
    const client = clientFor([
      withGroups(membership('ws-ro', 'RO Workspace', 'usr-granular', 'MEMBER'), {
        brain: 'view',
      }),
    ]);
    const view = render(<App apiClient={client} initialTab="brain" />);
    await signIn(view, client, user('usr-granular', 'Granular User', 'granular@corp.com'));

    await view.findAllByText('RO Workspace');
    expect(view.queryByTestId('btn-create-document')).not.toBeInTheDocument();
  });

  it('hides modules the member cannot view and opens the first visible one', async () => {
    const client = clientFor([
      withGroups(membership('ws-none', 'None Workspace', 'usr-granular', 'MEMBER'), {
        integrations: 'view',
      }),
    ]);
    const view = render(<App apiClient={client} initialTab="brain" />);
    await signIn(view, client, user('usr-granular', 'Granular User', 'granular@corp.com'));

    await view.findAllByText('None Workspace');
    expect(await view.findByTestId('screen-connect')).toBeInTheDocument();
    for (const id of [
      'sidebar-issues-button',
      'sidebar-pbis-button',
      'sidebar-agents-button',
      'sidebar-design-button',
      'sidebar-product-button',
      'sidebar-e2e-button',
    ])
      expect(view.queryByTestId(id)).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Brain' })).not.toBeInTheDocument();
    expect(view.getByTestId('sidebar-settings-footer-button')).toBeInTheDocument();
  });

  it('falls back to Settings when no module is visible', async () => {
    const client = clientFor([
      withGroups(membership('ws-empty', 'Empty Workspace', 'usr-granular', 'MEMBER'), {}),
    ]);
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    vi.spyOn(client, 'getPermissionGroups').mockResolvedValue([]);
    const view = render(<App apiClient={client} initialTab="issues" />);
    await signIn(view, client, user('usr-granular', 'Granular User', 'granular@corp.com'));

    expect(await view.findByTestId('screen-settings')).toBeInTheDocument();
    expect(view.queryByText('Integrações', { selector: 'div' })).not.toBeInTheDocument();
  });

  it('opens Connect for users who cannot manage integrations', async () => {
    const client = clientFor([
      membership('ws-no-manage', 'NoManage Workspace', 'usr-nomanage', 'MEMBER', {
        canManageIntegrations: false,
      }),
    ]);
    const view = render(<App apiClient={client} initialTab="connect" />);
    await signIn(view, client, user('usr-nomanage', 'NoManage User', 'nomanage@corp.com'));

    await view.findAllByText('NoManage Workspace');
    expect(await view.findByTestId('screen-connect')).toBeInTheDocument();
  });

  it('handles getWorkspaces rejection gracefully without crashing', async () => {
    const client = clientFor(new Error('Workspaces unavailable'));
    const view = render(<App apiClient={client} initialTab="brain" />);
    await signIn(view, client, user('usr-fail', 'Fail User', 'fail@corp.com'));

    expect((await view.findAllByText('Fail User')).length).toBeGreaterThan(0);
    expect(client.getWorkspaceId()).toBeNull();
  });

  it('allows deleting a workspace and selects remaining workspace or resets to empty', async () => {
    const primary = membership('ws-1', 'Primary Corp', 'usr-admin', 'ADMIN', {
      canManageMembers: true,
    });
    const secondary = membership('ws-2', 'Secondary Team', 'usr-admin', 'ADMIN', {
      canManageMembers: true,
    });
    const client = clientFor([primary, secondary]);
    vi.spyOn(client, 'getWorkspaceMembers').mockImplementation((wsId) =>
      Promise.resolve([wsId === 'ws-1' ? primary.member : secondary.member]),
    );
    const deleteSpy = vi.spyOn(client, 'deleteWorkspace').mockResolvedValue({ success: true });

    const view = render(<App apiClient={client} initialTab="brain" />);
    await signIn(view, client, user('usr-admin', 'Admin User', 'admin@corp.com'));
    await view.findByText('Primary Corp');
    expect(client.getWorkspaceId()).toBe('ws-1');

    const deleteActive = async (name: string) => {
      fireEvent.click(await view.findByRole('button', { name: 'Excluir workspace' }));
      fireEvent.change(
        view.getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
        { target: { value: name } },
      );
      fireEvent.click(await view.findByRole('button', { name: 'Confirmar exclusão' }));
      fireEvent.click(await view.findByRole('button', { name: 'Excluir workspace' }));
    };

    fireEvent.click(view.getByRole('button', { name: 'Configurações' }));
    await deleteActive('Primary Corp');
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('ws-1');
      expect(client.getWorkspaceId()).toBe('ws-2');
    });

    await deleteActive('Secondary Team');
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('ws-2');
      expect(client.getWorkspaceId()).toBeNull();
    });
  });

  it('synchronizes language switching from Settings with apiClient and document lang', async () => {
    const client = clientFor([membership('ws-1', 'Primary Corp', 'usr-1')]);
    withSession(client, user('usr-1', 'Ana', 'ana@example.com'));

    const view = render(<App apiClient={client} initialLocale="pt-BR" initialTab="settings" />);

    expect(client.getLocale()).toBe('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');

    fireEvent.change(await view.findByTestId('settings-locale-select'), {
      target: { value: 'en-US' },
    });

    expect(client.getLocale()).toBe('en-US');
    expect(document.documentElement.lang).toBe('en-US');
  });
});
