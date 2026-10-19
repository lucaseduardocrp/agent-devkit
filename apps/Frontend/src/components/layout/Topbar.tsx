import { useState, useEffect, useRef } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import type { NavTab } from './Sidebar.js';
import { useI18n, type TranslationKey } from '../../lib/i18n/index.js';
import {
  type WorkspaceRole,
  getRoleBadgeClass,
} from '../../features/workspaces/workspace-types.js';
import { ActivityCenter } from '../../features/activities/ActivityCenter.js';
import { getUserInitials } from '../../features/auth/auth-types.js';

export interface TopbarProps {
  readonly activeTab: NavTab;
  readonly userName?: string;
  readonly userEmail?: string;
  readonly userRole?: WorkspaceRole;
  readonly userInitials?: string;
  readonly isAuthenticated?: boolean;
  readonly onAuthClick?: () => void;
  readonly onLogout?: () => void;
  readonly className?: string;
}

const titleKeys: Record<NavTab, TranslationKey> = {
  dashboard: 'nav.dashboard',
  inbox: 'nav.inbox',
  issues: 'nav.issues',
  pbis: 'nav.pbis',
  brain: 'nav.brain',
  agents: 'nav.agents',
  spec: 'nav.spec',
  releaseNotes: 'nav.releaseNotes',
  design: 'nav.design',
  testplans: 'nav.testPlans',
  e2e: 'nav.e2e',
  connect: 'nav.connect',
  settings: 'nav.settings',
  workspaces: 'nav.workspaces',
};

const roleKeys: Record<WorkspaceRole, TranslationKey> = {
  ADMIN: 'workspaces.roleAdmin',
  INTEGRATOR: 'workspaces.roleIntegrator',
  MEMBER: 'workspaces.roleMember',
  VIEWER: 'workspaces.roleViewer',
};

/* CRITICAL CONSTRAINT: NEVER add isConnected, Search, or Notification to Topbar.tsx */
export function Topbar({
  activeTab,
  userName,
  userEmail,
  userRole,
  userInitials,
  isAuthenticated,
  onAuthClick,
  onLogout,
  className,
}: TopbarProps) {
  const { t } = useI18n();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  const handleLogoutClick = () => {
    setIsMenuOpen(false);
    onLogout?.();
  };

  return (
    <header
      className={cn(
        'flex h-[56px] items-center gap-3 border-b border-border bg-surface-1 px-5',
        className,
      )}
    >
      <h1 className="flex-1 text-base font-semibold text-[var(--text-primary)]">
        {t(titleKeys[activeTab])}
      </h1>

      <ActivityCenter />

      {isAuthenticated ? (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setIsMenuOpen((prev) => !prev)}
            aria-expanded={isMenuOpen}
            aria-haspopup="true"
            className={cn(
              'flex select-none items-center gap-2 rounded-full border border-border bg-surface-0 px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:border-border-strong hover:text-[var(--text-primary)]',
              isMenuOpen && 'border-border-accent bg-surface-2 text-[var(--text-primary)]',
            )}
            aria-label={t('topbar.profileLabel', { name: userName ?? t('topbar.user') })}
            data-testid="topbar-user-menu-button"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--bg-pro)] text-xs font-semibold text-pro-foreground">
              {userInitials ?? getUserInitials(userName, userEmail)}
            </span>
            {userName && <span className="hidden sm:inline text-sm font-medium">{userName}</span>}
            {userRole && (
              <span
                className={cn(
                  'rounded border px-1.5 py-0.5 text-xs font-semibold leading-normal',
                  getRoleBadgeClass(userRole),
                )}
                data-testid="topbar-user-role-badge"
              >
                {t(roleKeys[userRole])}
              </span>
            )}
            <i
              className={cn(
                'ti ti-chevron-down text-sm text-[var(--text-secondary)] transition-transform duration-200',
                isMenuOpen && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>

          {isMenuOpen && (
            <div
              className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-border bg-surface-1 p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
              role="menu"
              aria-orientation="vertical"
              aria-labelledby="topbar-user-menu-button"
              data-testid="topbar-user-dropdown"
            >
              <div className="border-b border-border px-3.5 py-2.5 text-sm">
                <p className="font-semibold truncate text-[var(--text-primary)]">
                  {userName ?? t('topbar.user')}
                </p>
                {userEmail && <p className="truncate text-xs text-muted mt-0.5">{userEmail}</p>}
              </div>

              <div className="py-1">
                {onLogout && (
                  <Button
                    type="button"
                    role="menuitem"
                    variant="ghost"
                    size="sm"
                    onClick={handleLogoutClick}
                    className="w-full justify-start gap-2 h-9 px-2.5 text-sm font-medium text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    data-testid="topbar-menu-logout"
                    leftIcon={<i className="ti ti-logout text-base" aria-hidden="true" />}
                  >
                    <span>{t('topbar.logout')}</span>
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : isAuthenticated === false ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAuthClick}
          className="rounded-full border-[var(--border-accent)] bg-[var(--fill-accent)]/10 text-accent-foreground hover:bg-[var(--fill-accent)]/20"
          aria-label={t('topbar.signInLabel')}
          leftIcon={<i className="ti ti-login text-sm" aria-hidden="true" />}
        >
          {t('topbar.login')}
        </Button>
      ) : null}
    </header>
  );
}
