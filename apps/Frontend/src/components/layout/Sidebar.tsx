import { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { type UserWorkspaceMembership } from '../../features/workspaces/workspace-types.js';
import { ResizableSidebar } from './ResizableSidebar.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../../features/workspaces/permissions.js';
import { canSeeTab } from './nav-access.js';

export type NavTab =
  | 'dashboard'
  | 'inbox'
  | 'issues'
  | 'pbis'
  | 'brain'
  | 'agents'
  | 'spec'
  | 'releaseNotes'
  | 'design'
  | 'testplans'
  | 'e2e'
  | 'connect'
  | 'settings'
  | 'workspaces';

export interface SidebarProps {
  readonly activeTab: NavTab;
  readonly onSelectTab: (tab: NavTab) => void;
  readonly inboxUnreadCount?: number;
  readonly userName?: string;
  readonly userInitials?: string;
  readonly isAuthenticated?: boolean;
  readonly onLoginClick?: () => void;
  readonly onLogout?: () => void;
  readonly workspaces?: readonly UserWorkspaceMembership[];
  readonly activeWorkspaceId?: string | null;
  readonly onSelectWorkspace?: (workspaceId: string) => void;
  readonly onCreateWorkspace?: (name: string) => Promise<void>;
  readonly onOpenMembersModal?: () => void;
  readonly className?: string;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  inboxUnreadCount = 0,
  isAuthenticated = true,
  workspaces,
  activeWorkspaceId,
  className,
}: SidebarProps) {
  const { t } = useI18n();
  const isTestChild = activeTab === 'testplans' || activeTab === 'e2e';
  const [testExpanded, setTestExpanded] = useState<boolean>(isTestChild);
  const isProductChild = activeTab === 'spec' || activeTab === 'releaseNotes';
  const [productExpanded, setProductExpanded] = useState<boolean>(isProductChild);

  const toggleTest = () => {
    setTestExpanded((prev) => !prev);
  };

  const activeMembership = workspaces?.find((w) => w.workspace.id === activeWorkspaceId);
  const { can } = usePermissions();
  // Modules the member cannot view are left out of the navigation entirely.
  const show = (tab: NavTab) => canSeeTab(tab, can);
  const showWork = show('issues') || show('pbis');
  const showProduct = show('spec') || show('releaseNotes');
  const showTest = show('testplans') || show('e2e');

  return (
    <ResizableSidebar
      className={cn(
        'border-r border-border bg-surface-1 [&_button]:cursor-pointer [&_a]:cursor-pointer',
        className,
      )}
      defaultWidth={240}
      minWidth={200}
      maxWidth={420}
      aria-label={t('runtime.mainNavigation')}
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
          <i className="ti ti-hexagon-letter-a text-xl text-accent-foreground" aria-hidden="true" />
          <span>Agent DevKit</span>
        </div>
      </div>

      {isAuthenticated && (
        <div className="border-b border-border px-3 py-2 text-sm">
          <button
            type="button"
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--fill-ghost-hover)]',
              activeTab === 'workspaces' &&
                'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
            )}
            onClick={() => onSelectTab('workspaces')}
            aria-current={activeTab === 'workspaces' ? 'page' : undefined}
            aria-label={t('runtime.manageWorkspaces')}
            data-testid="sidebar-workspaces-button"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                {activeMembership ? activeMembership.workspace.name : t('nav.workspaces')}
              </span>
            </div>
            <i
              className="ti ti-switch-horizontal text-base text-[var(--text-secondary)]"
              aria-hidden="true"
            />
          </button>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto py-2">
        {showWork && (
          <div className="pb-2">
            <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted">
              {t('nav.work')}
            </div>
            {show('issues') && (
              <button
                type="button"
                onClick={() => onSelectTab('issues')}
                aria-current={activeTab === 'issues' ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--fill-ghost-hover)]',
                  activeTab === 'issues' &&
                    'bg-[var(--fill-ghost-selected)] font-semibold text-[var(--text-primary)]',
                )}
                data-testid="sidebar-issues-button"
              >
                <i className="ti ti-circle-check text-lg" aria-hidden="true" />
                <span>{t('nav.issues')}</span>
              </button>
            )}
            {show('pbis') && (
              <button
                type="button"
                onClick={() => onSelectTab('pbis')}
                aria-current={activeTab === 'pbis' ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--fill-ghost-hover)]',
                  activeTab === 'pbis' &&
                    'bg-[var(--fill-ghost-selected)] font-semibold text-[var(--text-primary)]',
                )}
                data-testid="sidebar-pbis-button"
              >
                <i className="ti ti-layout-kanban text-lg" aria-hidden="true" />
                <span>{t('nav.pbis')}</span>
              </button>
            )}
          </div>
        )}
        <div className="mb-1 flex flex-col">
          <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted">
            {t('runtime.core')}
          </div>
          {(['dashboard', 'inbox'] as const).filter(show).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => onSelectTab(tab)}
              aria-current={activeTab === tab ? 'page' : undefined}
              className={cn(
                'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                activeTab === tab &&
                  'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
              )}
              data-testid={`sidebar-${tab}-button`}
            >
              <i
                className={cn(
                  'ti text-lg',
                  tab === 'dashboard' ? 'ti-layout-dashboard' : 'ti-inbox',
                )}
                aria-hidden="true"
              />
              <span>{t(`nav.${tab}`)}</span>
              {tab === 'inbox' && inboxUnreadCount > 0 && (
                <span
                  className="ml-auto rounded-full bg-[var(--surface-2)] px-1.5 text-xs"
                  aria-label={`${inboxUnreadCount} unread`}
                >
                  {inboxUnreadCount}
                </span>
              )}
            </button>
          ))}
          {show('agents') && (
            <button
              type="button"
              className={cn(
                'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                activeTab === 'agents' &&
                  'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
              )}
              onClick={() => onSelectTab('agents')}
              aria-current={activeTab === 'agents' ? 'page' : undefined}
              data-testid="sidebar-agents-button"
            >
              <i className="ti ti-robot text-lg" aria-hidden="true" />
              <span>{t('nav.agents')}</span>
            </button>
          )}

          {show('brain') && (
            <button
              type="button"
              className={cn(
                'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                activeTab === 'brain' &&
                  'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
              )}
              onClick={() => onSelectTab('brain')}
              aria-current={activeTab === 'brain' ? 'page' : undefined}
            >
              <i className="ti ti-brain text-lg" aria-hidden="true" />
              <span>{t('nav.brain')}</span>
            </button>
          )}

          {show('design') && (
            <button
              type="button"
              className={cn(
                'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                activeTab === 'design' &&
                  'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
              )}
              onClick={() => onSelectTab('design')}
              aria-current={activeTab === 'design' ? 'page' : undefined}
              data-testid="sidebar-design-button"
            >
              <i className="ti ti-palette text-lg" aria-hidden="true" />
              <span>{t('nav.design')}</span>
            </button>
          )}

          {showProduct && (
            <>
              <button
                type="button"
                className={cn(
                  'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                  (isProductChild || productExpanded) &&
                    'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
                )}
                onClick={() => setProductExpanded((prev) => !prev)}
                aria-expanded={productExpanded}
                data-testid="sidebar-product-button"
              >
                <i className="ti ti-package text-lg" aria-hidden="true" />
                <span>{t('nav.product')}</span>
                <i
                  className={cn(
                    'ti ti-chevron-right ml-auto text-sm transition-transform duration-200',
                    productExpanded && 'rotate-90',
                  )}
                  aria-hidden="true"
                />
              </button>

              <div
                className={cn(
                  'overflow-hidden transition-all duration-200 ease-in-out',
                  productExpanded ? 'max-h-52' : 'max-h-0',
                )}
              >
                {show('spec') && (
                  <button
                    type="button"
                    className={cn(
                      'flex w-full select-none items-center gap-2.5 py-1.5 pl-9 pr-4 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                      activeTab === 'spec' &&
                        'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
                    )}
                    onClick={() => onSelectTab('spec')}
                    aria-current={activeTab === 'spec' ? 'page' : undefined}
                    data-testid="sidebar-spec-button"
                  >
                    <i className="ti ti-file-description text-lg" aria-hidden="true" />
                    <span>{t('nav.spec')}</span>
                  </button>
                )}
                {show('releaseNotes') && (
                  <button
                    type="button"
                    className={cn(
                      'flex w-full select-none items-center gap-2.5 py-1.5 pl-9 pr-4 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                      activeTab === 'releaseNotes' &&
                        'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
                    )}
                    onClick={() => onSelectTab('releaseNotes')}
                    aria-current={activeTab === 'releaseNotes' ? 'page' : undefined}
                    data-testid="sidebar-release-notes-button"
                  >
                    <i className="ti ti-speakerphone text-lg" aria-hidden="true" />
                    <span>{t('nav.releaseNotes')}</span>
                  </button>
                )}
              </div>
            </>
          )}

          {showTest && (
            <>
              <button
                type="button"
                className={cn(
                  'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                  (isTestChild || testExpanded) &&
                    'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
                )}
                onClick={toggleTest}
                aria-expanded={testExpanded}
              >
                <i className="ti ti-test-pipe text-lg" aria-hidden="true" />
                <span>{t('nav.azure')}</span>
                <i
                  className={cn(
                    'ti ti-chevron-right ml-auto text-sm transition-transform duration-200',
                    testExpanded && 'rotate-90',
                  )}
                  aria-hidden="true"
                />
              </button>

              <div
                className={cn(
                  'overflow-hidden transition-all duration-200 ease-in-out',
                  testExpanded ? 'max-h-52' : 'max-h-0',
                )}
              >
                {show('testplans') && (
                  <button
                    type="button"
                    className={cn(
                      'flex w-full select-none items-center gap-2.5 py-1.5 pl-9 pr-4 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                      activeTab === 'testplans' &&
                        'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
                    )}
                    onClick={() => onSelectTab('testplans')}
                    aria-current={activeTab === 'testplans' ? 'page' : undefined}
                  >
                    <i className="ti ti-checklist text-lg" aria-hidden="true" />
                    <span>{t('nav.testPlans')}</span>
                  </button>
                )}
                {show('e2e') && (
                  <button
                    type="button"
                    className={cn(
                      'flex w-full select-none items-center gap-2.5 py-1.5 pl-9 pr-4 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                      activeTab === 'e2e' &&
                        'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
                    )}
                    onClick={() => onSelectTab('e2e')}
                    aria-current={activeTab === 'e2e' ? 'page' : undefined}
                    data-testid="sidebar-e2e-button"
                  >
                    <i className="ti ti-player-play text-lg" aria-hidden="true" />
                    <span>{t('nav.e2e')}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {show('connect') && (
          <div className="mb-1">
            <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted">
              {t('runtime.integrations')}
            </div>
            <button
              type="button"
              className={cn(
                'flex w-full select-none items-center gap-2.5 px-4 py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                activeTab === 'connect' &&
                  'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
              )}
              onClick={() => onSelectTab('connect')}
              aria-current={activeTab === 'connect' ? 'page' : undefined}
            >
              <i className="ti ti-plug-connected text-lg" aria-hidden="true" />
              <span>{t('nav.connect')}</span>
            </button>
          </div>
        )}
      </nav>

      <div className="border-t border-border p-2">
        <button
          type="button"
          className={cn(
            'flex w-full select-none items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
            activeTab === 'settings' &&
              'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
          )}
          onClick={() => onSelectTab('settings')}
          aria-current={activeTab === 'settings' ? 'page' : undefined}
          data-testid="sidebar-settings-footer-button"
        >
          <i className="ti ti-settings text-lg" aria-hidden="true" />
          <span>{t('nav.settings')}</span>
        </button>
      </div>
    </ResizableSidebar>
  );
}
