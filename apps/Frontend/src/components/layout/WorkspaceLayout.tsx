import { cn } from '../../lib/utils.js';
import { Sidebar, type NavTab } from './Sidebar.js';
import { Topbar } from './Topbar.js';

import type {
  UserWorkspaceMembership,
  WorkspaceRole,
} from '../../features/workspaces/workspace-types.js';

export interface WorkspaceLayoutProps {
  readonly activeTab: NavTab;
  readonly onSelectTab: (tab: NavTab) => void;
  readonly inboxUnreadCount?: number;
  readonly userName?: string;
  readonly userEmail?: string;
  readonly userRole?: WorkspaceRole;
  readonly userInitials?: string;
  readonly isAuthenticated?: boolean;
  readonly onLogout?: () => void;
  readonly onAuthClick?: () => void;
  readonly workspaces?: readonly UserWorkspaceMembership[];
  readonly activeWorkspaceId?: string | null;
  readonly onSelectWorkspace?: (workspaceId: string) => void;
  readonly onCreateWorkspace?: (name: string) => Promise<void>;
  readonly onOpenMembersModal?: () => void;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export function WorkspaceLayout({
  activeTab,
  onSelectTab,
  inboxUnreadCount,
  userName,
  userEmail,
  userRole,
  userInitials,
  isAuthenticated,
  onLogout,
  onAuthClick,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenMembersModal,
  className,
  children,
}: WorkspaceLayoutProps) {
  const activeMembership = workspaces?.find((w) => w.workspace.id === activeWorkspaceId);
  const effectiveUserRole = userRole ?? activeMembership?.member.role;

  return (
    <div
      className={cn(
        'flex h-screen w-full overflow-hidden bg-surface-0 text-[var(--text-primary)]',
        className,
      )}
    >
      <Sidebar
        activeTab={activeTab}
        onSelectTab={onSelectTab}
        inboxUnreadCount={inboxUnreadCount}
        userName={userName}
        userInitials={userInitials}
        isAuthenticated={isAuthenticated}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
        onCreateWorkspace={onCreateWorkspace}
        onOpenMembersModal={onOpenMembersModal}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar
          activeTab={activeTab}
          userName={userName}
          userEmail={userEmail}
          userRole={effectiveUserRole}
          userInitials={userInitials}
          isAuthenticated={isAuthenticated}
          onAuthClick={onAuthClick}
          onLogout={onLogout}
        />
        <main className="flex-1 overflow-y-auto p-5">{children}</main>
      </div>
    </div>
  );
}
