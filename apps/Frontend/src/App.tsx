import { useState, useEffect, useCallback, useRef } from 'react';
import { ApiClient } from './lib/api-client.js';
import { cn } from './lib/utils.js';
import { WorkspaceLayout } from './components/layout/WorkspaceLayout.js';
import type { NavTab } from './components/layout/Sidebar.js';
import { BrainView } from './features/brain/BrainView.js';
import { AgentsView } from './features/agents/AgentsView.js';
import { TestPlansView } from './features/testplans/TestPlansView.js';
import type { AutomateSelection } from './features/testplans/TestSuiteTree.js';
import { SpecView } from './features/spec/SpecView.js';
import { ReleaseNotesView } from './features/release-notes/ReleaseNotesView.js';
import { ConnectView } from './features/connect/ConnectView.js';
import { SettingsView } from './features/settings/SettingsView.js';
import { WorkspacesView } from './features/workspaces/WorkspacesView.js';
import { AuthModal } from './features/auth/AuthModal.js';
import type { UserWorkspaceMembership } from './features/workspaces/workspace-types.js';
import {
  type UserProfile,
  getUserInitials,
  getStoredToken,
  setStoredToken,
} from './features/auth/auth-types.js';
import { I18nProvider, useI18n, type SupportedLocale } from './lib/i18n/index.js';
import { ActivityProvider } from './features/activities/ActivityCenter.js';
import { DesignView } from './features/design/DesignView.js';
import { WorkView } from './features/issues/WorkView.js';
import { PbiView } from './features/pbi/PbiView.js';
import { E2eView } from './features/e2e/E2eView.js';
import { accessFor, allows, PermissionsProvider } from './features/workspaces/permissions.js';
import type { ModuleOperation, PermissionModule } from './features/workspaces/workspace-types.js';
import { canSeeTab, NAV_TAB_ORDER } from './components/layout/nav-access.js';
import { MediaProvider } from './features/shared/media.js';

export interface AppProps {
  readonly apiClient?: ApiClient;
  readonly initialTab?: NavTab;
  readonly defaultOwnerId?: string;
  readonly initialLocale?: SupportedLocale;
  readonly className?: string;
}

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

// In production (Railway or Vercel), VITE_API_BASE_URL must point at the deployed backend
// (Railway), since the frontend and backend are served from different origins
// there. Left unset, ApiClient falls back to http://localhost:3000 for local dev.
const defaultApiClient = new ApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL });

export function App({
  apiClient = defaultApiClient,
  initialTab = 'brain',
  defaultOwnerId = 'default-owner',
  initialLocale,
  className,
}: AppProps) {
  return (
    <I18nProvider
      initialLocale={initialLocale}
      onLocaleChange={(locale) => apiClient.setLocale(locale)}
    >
      <ActivityProvider>
        <MediaProvider apiClient={apiClient}>
          <AppContent
            apiClient={apiClient}
            initialTab={initialTab}
            defaultOwnerId={defaultOwnerId}
            className={className}
          />
        </MediaProvider>
      </ActivityProvider>
    </I18nProvider>
  );
}

function AppContent({
  apiClient = defaultApiClient,
  initialTab = 'brain',
  defaultOwnerId = 'default-owner',
  className,
}: Omit<AppProps, 'initialLocale'>) {
  const { locale, t } = useI18n();

  useEffect(() => {
    apiClient.setLocale(locale);
  }, [apiClient, locale]);

  const [activeTab, setActiveTab] = useState<NavTab>(initialTab);
  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
  const [pbiRefreshToken, setPbiRefreshToken] = useState(0);
  // Saved test cases a new E2E run starts from, when it is opened from Test Plans.
  const [e2eSeed, setE2eSeed] = useState<{
    readonly selection: AutomateSelection;
    readonly id: number;
  } | null>(null);
  // The seed opens the form once: coming back to E2E later shows the list.
  useEffect(() => {
    if (activeTab !== 'e2e') setE2eSeed(null);
  }, [activeTab]);
  const [ownerId, setOwnerId] = useState<string>(defaultOwnerId);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking');
  const [workspaces, setWorkspaces] = useState<readonly UserWorkspaceMembership[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const activeWorkspaceIdRef = useRef<string | null>(null);

  const setActiveWorkspace = (workspaceId: string | null) => {
    activeWorkspaceIdRef.current = workspaceId;
    setActiveWorkspaceId(workspaceId);
  };

  const loadWorkspaces = useCallback(async () => {
    try {
      const list = await apiClient.getWorkspaces();
      setWorkspaces(list);
      const currentId = activeWorkspaceIdRef.current;
      const current = currentId ? list.find((item) => item.workspace.id === currentId) : undefined;
      const next = current ?? list[0];
      if (next && next.workspace.id !== currentId) {
        apiClient.setWorkspaceId(next.workspace.id);
        setOwnerId(next.workspace.id);
        setActiveWorkspace(next.workspace.id);
      }
    } catch {
      // Ignored if user not yet authorized
    }
  }, [apiClient]);

  useEffect(() => {
    let isMounted = true;

    void apiClient.getHealth().catch(() => {});

    const oauthToken = new URLSearchParams(window.location.hash.slice(1)).get('oauth_token');
    if (oauthToken) {
      setStoredToken(oauthToken);
      window.history.replaceState(
        null,
        document.title,
        window.location.pathname + window.location.search,
      );
    }
    const token = oauthToken ?? getStoredToken();
    if (token) {
      apiClient.setToken(token);
      void apiClient
        .getMe()
        .then((user) => {
          if (isMounted) {
            setCurrentUser(user);
            setAuthStatus('authenticated');
            void loadWorkspaces();
          }
        })
        .catch(() => {
          if (isMounted) {
            setStoredToken(null);
            apiClient.setToken(null);
            setCurrentUser(null);
            setWorkspaces([]);
            setActiveWorkspace(null);
            setAuthStatus('unauthenticated');
          }
        });
    } else {
      setAuthStatus('unauthenticated');
    }

    return () => {
      isMounted = false;
    };
  }, [apiClient, loadWorkspaces]);

  const handleLoginSuccess = (user: UserProfile, token: string) => {
    setStoredToken(token);
    apiClient.setToken(token);
    setCurrentUser(user);
    setAuthStatus('authenticated');
    void loadWorkspaces();
  };

  const handleLogout = () => {
    void apiClient.logout().catch(() => {});
    setStoredToken(null);
    apiClient.setToken(null);
    apiClient.setWorkspaceId(null);
    setCurrentUser(null);
    setAuthStatus('unauthenticated');
    setWorkspaces([]);
    setActiveWorkspace(null);
    setOwnerId(defaultOwnerId);
  };

  const handleSelectWorkspace = (workspaceId: string) => {
    setInboxUnreadCount(0);
    setActiveWorkspace(workspaceId);
    apiClient.setWorkspaceId(workspaceId);
    setOwnerId(workspaceId);
  };

  const handleCreateWorkspace = async (data: { name: string; slug?: string }) => {
    const created = await apiClient.createWorkspace(data);
    setWorkspaces((prev) => [...prev, created]);
    setActiveWorkspace(created.workspace.id);
    apiClient.setWorkspaceId(created.workspace.id);
    setOwnerId(created.workspace.id);
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    await apiClient.deleteWorkspace(workspaceId);
    const remaining = workspaces.filter((w) => w.workspace.id !== workspaceId);
    setWorkspaces(remaining);
    const nextWs = remaining[0];
    if (nextWs) {
      setActiveWorkspace(nextWs.workspace.id);
      apiClient.setWorkspaceId(nextWs.workspace.id);
      setOwnerId(nextWs.workspace.id);
    } else {
      setActiveWorkspace(null);
      apiClient.setWorkspaceId(null);
      if (currentUser) {
        setOwnerId(currentUser.id);
      }
    }
  };

  const activeMembership = workspaces.find((w) => w.workspace.id === activeWorkspaceId);
  const access = accessFor(activeMembership);
  const can = (module: PermissionModule, operation: ModuleOperation = 'view') =>
    allows(access.modules[module], operation);
  const readOnly = (module: PermissionModule) => !can(module, 'edit');
  // A tab the member may not view (e.g. after switching workspace) falls back to the first
  // visible one, so hidden modules are never rendered.
  const currentTab = canSeeTab(activeTab, can)
    ? activeTab
    : (NAV_TAB_ORDER.find((tab) => canSeeTab(tab, can)) ?? 'settings');
  if (authStatus === 'checking') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-[var(--surface-0)]"
        aria-label={t('auth.checkingSession')}
        data-testid="auth-session-loading"
      >
        <div className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
          <i
            className="ti ti-loader animate-spin text-xl text-[var(--text-accent)]"
            aria-hidden="true"
          />
          <span>{t('auth.checkingSession')}</span>
        </div>
      </main>
    );
  }

  if (authStatus === 'unauthenticated' || !currentUser) {
    return (
      <AuthModal
        isOpen={true}
        canClose={false}
        onClose={() => {}}
        onSuccess={handleLoginSuccess}
        apiClient={apiClient}
      />
    );
  }

  return (
    <PermissionsProvider access={access}>
      <h1 className="sr-only">{t('runtime.application')}</h1>
      <WorkspaceLayout
        activeTab={currentTab}
        onSelectTab={setActiveTab}
        inboxUnreadCount={inboxUnreadCount}
        userName={currentUser ? currentUser.name || currentUser.email : undefined}
        userEmail={currentUser?.email}
        userRole={activeMembership?.member.role}
        userInitials={
          currentUser ? getUserInitials(currentUser.name, currentUser.email) : undefined
        }
        isAuthenticated={Boolean(currentUser)}
        onLogout={handleLogout}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        className={cn(className)}
      >
        {(currentTab === 'dashboard' || currentTab === 'inbox' || currentTab === 'issues') && (
          <WorkView
            key={activeWorkspaceId ?? 'no-workspace'}
            apiClient={apiClient}
            workspaceId={activeWorkspaceId}
            tab={currentTab}
            currentUserId={currentUser.id}
            isReadOnly={readOnly('issues')}
            canManageCosts={access.workspace.manageCosts}
            onInboxCountChange={setInboxUnreadCount}
            onOpenIssues={() => setActiveTab('issues')}
          />
        )}
        {currentTab === 'pbis' && (
          <PbiView
            key={activeWorkspaceId ?? 'no-workspace'}
            apiClient={apiClient}
            workspaceId={activeWorkspaceId}
            refreshToken={pbiRefreshToken}
            onPbiChanged={() => setPbiRefreshToken((value) => value + 1)}
            isReadOnly={readOnly('pbis')}
            onOpenIssues={() => setActiveTab('issues')}
            onOpenTestPlans={() => setActiveTab('testplans')}
          />
        )}
        {currentTab === 'brain' && (
          <BrainView
            apiClient={apiClient}
            defaultOwnerId={ownerId}
            isReadOnly={readOnly('brain')}
          />
        )}
        {currentTab === 'agents' && (
          <AgentsView
            apiClient={apiClient}
            activeWorkspaceId={activeWorkspaceId}
            isReadOnly={readOnly('agents')}
          />
        )}
        {currentTab === 'testplans' && (
          <TestPlansView
            apiClient={apiClient}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={handleSelectWorkspace}
            initialTab="saved"
            isReadOnly={readOnly('testplans')}
            onAutomate={
              can('e2e', 'edit')
                ? (selection) => {
                    setE2eSeed({ selection, id: Date.now() });
                    setActiveTab('e2e');
                  }
                : undefined
            }
            onOpenIntegrations={can('integrations') ? () => setActiveTab('connect') : undefined}
          />
        )}
        {currentTab === 'e2e' && (
          <E2eView
            key={`${activeWorkspaceId ?? 'no-workspace'}:${e2eSeed?.id ?? ''}`}
            apiClient={apiClient}
            isReadOnly={readOnly('e2e')}
            initialSavedCases={e2eSeed?.selection}
            onOpenAgents={() => setActiveTab('agents')}
            onOpenIntegrations={() => setActiveTab('connect')}
          />
        )}
        {currentTab === 'spec' && (
          <SpecView
            apiClient={apiClient}
            activeWorkspaceId={activeWorkspaceId}
            canManageTemplates={activeMembership?.member.role === 'ADMIN'}
            isReadOnly={readOnly('specs')}
            canPublishToBrain={can('brain', 'edit')}
          />
        )}
        {currentTab === 'releaseNotes' && (
          <ReleaseNotesView
            key={activeWorkspaceId ?? 'no-workspace'}
            apiClient={apiClient}
            workspaceId={activeWorkspaceId}
            isReadOnly={readOnly('releaseNotes')}
          />
        )}
        {currentTab === 'design' && (
          <DesignView
            apiClient={apiClient}
            activeWorkspaceId={activeWorkspaceId}
            isReadOnly={readOnly('design')}
            onManageRepositories={() => setActiveTab('connect')}
          />
        )}
        {currentTab === 'connect' && (
          <ConnectView
            apiClient={apiClient}
            isAuthenticated={true}
            canManageIntegrations={can('integrations', 'edit')}
          />
        )}
        {currentTab === 'workspaces' && (
          <WorkspacesView
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={handleSelectWorkspace}
            onCreateWorkspace={handleCreateWorkspace}
          />
        )}
        {currentTab === 'settings' && (
          <SettingsView
            apiClient={apiClient}
            activeMembership={activeMembership}
            currentUserId={currentUser?.id}
            onDeleteWorkspace={handleDeleteWorkspace}
            onWorkspaceRenamed={(renamed) =>
              setWorkspaces((current) =>
                current.map((item) =>
                  item.workspace.id === renamed.id
                    ? { ...item, workspace: { ...item.workspace, name: renamed.name } }
                    : item,
                ),
              )
            }
          />
        )}
      </WorkspaceLayout>
    </PermissionsProvider>
  );
}
