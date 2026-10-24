import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  | 'integrationTests'
  | 'loadTests'
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

const COLLAPSED_KEY = 'adk.sidebar.collapsed';
/** While dragging, narrower than this the navigation already shows only icons. */
const COMPACT_BELOW = 180;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private windows may block storage: the choice just is not remembered.
  }
}

/**
 * The module name next to an icon of the collapsed sidebar. Portaled with fixed coordinates so
 * the scrolling navigation does not clip it.
 */
function Tooltip({
  label,
  enabled,
  children,
}: {
  readonly label: string;
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  if (!enabled) return <>{children}</>;
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPosition({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };
  return (
    <div
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={() => setPosition(null)}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={() => setPosition(null)}
    >
      {children}
      {position &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[1000] -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] shadow-lg"
            style={position}
          >
            {label}
          </div>,
          document.body,
        )}
    </div>
  );
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
  const [folded, setFolded] = useState(readCollapsed);
  const isTestChild =
    activeTab === 'testplans' ||
    activeTab === 'e2e' ||
    activeTab === 'integrationTests' ||
    activeTab === 'loadTests';
  const [testExpanded, setTestExpanded] = useState<boolean>(isTestChild);
  const isProductChild =
    activeTab === 'design' || activeTab === 'spec' || activeTab === 'releaseNotes';
  const [productExpanded, setProductExpanded] = useState<boolean>(isProductChild);

  const activeMembership = workspaces?.find((w) => w.workspace.id === activeWorkspaceId);
  const { can } = usePermissions();
  // Modules the member cannot view are left out of the navigation entirely.
  const show = (tab: NavTab) => canSeeTab(tab, can);
  const showWork = show('issues') || show('pbis') || show('inbox');
  const showProduct = show('design') || show('spec') || show('releaseNotes');
  const showTest =
    show('testplans') || show('e2e') || show('integrationTests') || show('loadTests');

  const setCollapsedTo = (value: boolean) => {
    writeCollapsed(value);
    setFolded(value);
  };
  const toggleCollapsed = () => setCollapsedTo(!folded);

  /** The navigation, full or as icons only; while dragging it follows the width under the pointer. */
  const renderContent = (collapsed: boolean) => {
    const itemClass = (active: boolean, nested = false) =>
      cn(
        'flex w-full select-none items-center gap-2.5 whitespace-nowrap py-1.5 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
        collapsed ? 'justify-center px-0 py-2' : nested ? 'pl-9 pr-4' : 'px-4',
        active && 'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
      );

    /** One module of the navigation; in the collapsed sidebar only its icon, named by a tooltip. */
    const item = (
      tab: NavTab,
      icon: string,
      label: string,
      options: { nested?: boolean; testId?: string; badge?: number } = {},
    ) =>
      show(tab) && (
        <Tooltip key={tab} label={label} enabled={collapsed}>
          <button
            type="button"
            className={cn(itemClass(activeTab === tab, options.nested), collapsed && 'relative')}
            onClick={() => onSelectTab(tab)}
            aria-current={activeTab === tab ? 'page' : undefined}
            aria-label={collapsed ? label : undefined}
            data-testid={options.testId}
          >
            <i className={cn('ti text-lg', icon)} aria-hidden="true" />
            {!collapsed && <span>{label}</span>}
            {options.badge !== undefined && options.badge > 0 && (
              <span
                className={cn(
                  'rounded-full bg-[var(--surface-2)] px-1.5 text-xs',
                  collapsed ? 'absolute right-2 top-0.5 px-1 text-[10px]' : 'ml-auto',
                )}
                aria-label={`${options.badge} unread`}
              >
                {options.badge}
              </span>
            )}
          </button>
        </Tooltip>
      );

    // The first section needs no line above it in the compact sidebar.
    const heading = (label: string, first = false) =>
      collapsed ? (
        first ? null : (
          <div className="mx-3 my-2 border-t border-border" aria-hidden="true" />
        )
      ) : (
        <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted">
          {label}
        </div>
      );

    /** Product and Test open their modules below; collapsed, the modules show as plain icons. */
    const group = (
      label: string,
      icon: string,
      expanded: boolean,
      hasActiveChild: boolean,
      toggle: () => void,
      children: ReactNode,
      testId?: string,
    ) =>
      collapsed ? (
        <>
          <div className="mx-3 my-1 border-t border-border" aria-hidden="true" />
          {children}
        </>
      ) : (
        <>
          <button
            type="button"
            className={itemClass(hasActiveChild || expanded)}
            onClick={toggle}
            aria-expanded={expanded}
            data-testid={testId}
          >
            <i className={cn('ti text-lg', icon)} aria-hidden="true" />
            <span>{label}</span>
            <i
              className={cn(
                'ti ti-chevron-right ml-auto text-sm transition-transform duration-200',
                expanded && 'rotate-90',
              )}
              aria-hidden="true"
            />
          </button>
          <div
            className={cn(
              'overflow-hidden transition-all duration-200 ease-in-out',
              expanded ? 'max-h-72' : 'max-h-0',
            )}
          >
            {children}
          </div>
        </>
      );

    const workspaceName = activeMembership ? activeMembership.workspace.name : t('nav.workspaces');

    return (
      <>
        {/* Same height as the Topbar, so both bottom borders line up. */}
        <div
          className={cn(
            'flex h-[56px] shrink-0 items-center gap-2 border-b border-border',
            collapsed ? 'justify-center px-2' : 'px-3',
          )}
        >
          {collapsed ? (
            <Tooltip label={workspaceName} enabled>
              <button
                type="button"
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-accent)] transition-colors hover:bg-[var(--fill-ghost-hover)]',
                  activeTab === 'workspaces' && 'bg-[var(--fill-ghost-selected)]',
                )}
                onClick={() => onSelectTab('workspaces')}
                aria-label={t('runtime.manageWorkspaces')}
                data-testid="sidebar-workspaces-button"
              >
                <i className="ti ti-hexagon-letter-a text-2xl" aria-hidden="true" />
              </button>
            </Tooltip>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 text-base font-semibold text-[var(--text-primary)]">
                <i
                  className="ti ti-hexagon-letter-a text-xl text-accent-foreground"
                  aria-hidden="true"
                />
                <span>Agent DevKit</span>
              </div>
              {isAuthenticated && (
                <button
                  type="button"
                  className={cn(
                    'ml-auto flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--fill-ghost-hover)]',
                    activeTab === 'workspaces' && 'bg-[var(--fill-ghost-selected)]',
                  )}
                  onClick={() => onSelectTab('workspaces')}
                  aria-current={activeTab === 'workspaces' ? 'page' : undefined}
                  aria-label={t('runtime.manageWorkspaces')}
                  title={workspaceName}
                  data-testid="sidebar-workspaces-button"
                >
                  <span className="truncate font-semibold text-[var(--text-primary)]">
                    {workspaceName}
                  </span>
                  <i
                    className="ti ti-switch-horizontal shrink-0 text-sm text-[var(--text-secondary)]"
                    aria-hidden="true"
                  />
                </button>
              )}
            </>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
          {showWork && (
            <div className="pb-2">
              {heading(t('nav.work'), true)}
              {item('issues', 'ti-circle-check', t('nav.issues'), {
                testId: 'sidebar-issues-button',
              })}
              {item('pbis', 'ti-layout-kanban', t('nav.pbis'), { testId: 'sidebar-pbis-button' })}
              {item('inbox', 'ti-inbox', t('nav.inbox'), {
                testId: 'sidebar-inbox-button',
                badge: inboxUnreadCount,
              })}
            </div>
          )}
          <div className="mb-1 flex flex-col">
            {heading(t('runtime.core'), !showWork)}
            {item('dashboard', 'ti-layout-dashboard', t('nav.dashboard'), {
              testId: 'sidebar-dashboard-button',
            })}
            {item('agents', 'ti-robot', t('nav.agents'), { testId: 'sidebar-agents-button' })}
            {item('brain', 'ti-brain', t('nav.brain'))}

            {showProduct &&
              group(
                t('nav.product'),
                'ti-package',
                productExpanded,
                isProductChild,
                () => setProductExpanded((prev) => !prev),
                <>
                  {item('design', 'ti-palette', t('nav.design'), {
                    nested: true,
                    testId: 'sidebar-design-button',
                  })}
                  {item('spec', 'ti-file-description', t('nav.spec'), {
                    nested: true,
                    testId: 'sidebar-spec-button',
                  })}
                  {item('releaseNotes', 'ti-speakerphone', t('nav.releaseNotes'), {
                    nested: true,
                    testId: 'sidebar-release-notes-button',
                  })}
                </>,
                'sidebar-product-button',
              )}

            {showTest &&
              group(
                t('nav.azure'),
                'ti-test-pipe',
                testExpanded,
                isTestChild,
                () => setTestExpanded((prev) => !prev),
                <>
                  {item('testplans', 'ti-checklist', t('nav.testPlans'), { nested: true })}
                  {item('e2e', 'ti-player-play', t('nav.e2e'), {
                    nested: true,
                    testId: 'sidebar-e2e-button',
                  })}
                  {item('integrationTests', 'ti-api', t('nav.integrationTests'), {
                    nested: true,
                    testId: 'sidebar-integrationTests-button',
                  })}
                  {item('loadTests', 'ti-gauge', t('nav.loadTests'), {
                    nested: true,
                    testId: 'sidebar-loadTests-button',
                  })}
                </>,
              )}
          </div>

          {show('connect') && (
            <div className="mb-1">
              {heading(t('runtime.integrations'))}
              {item('connect', 'ti-plug-connected', t('nav.connect'))}
            </div>
          )}
        </nav>

        <div
          className={cn('flex border-t border-border p-2', collapsed ? 'flex-col gap-1' : 'gap-1')}
        >
          <Tooltip label={t('nav.settings')} enabled={collapsed}>
            <button
              type="button"
              className={cn(
                'flex w-full select-none items-center gap-2.5 rounded-md py-2 text-left text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                collapsed ? 'justify-center px-0' : 'px-3',
                activeTab === 'settings' &&
                  'bg-[var(--fill-ghost-selected)] font-medium text-[var(--text-primary)]',
              )}
              onClick={() => onSelectTab('settings')}
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              aria-label={collapsed ? t('nav.settings') : undefined}
              data-testid="sidebar-settings-footer-button"
            >
              <i className="ti ti-settings text-lg" aria-hidden="true" />
              {!collapsed && <span>{t('nav.settings')}</span>}
            </button>
          </Tooltip>
          <Tooltip label={t('runtime.expandSidebar')} enabled={collapsed}>
            <button
              type="button"
              className={cn(
                'flex shrink-0 items-center justify-center rounded-md py-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]',
                collapsed ? 'w-full' : 'w-9',
              )}
              onClick={toggleCollapsed}
              aria-label={collapsed ? t('runtime.expandSidebar') : t('runtime.collapseSidebar')}
              title={collapsed ? undefined : t('runtime.collapseSidebar')}
              aria-expanded={!collapsed}
              data-testid="sidebar-collapse-button"
            >
              <i
                className={cn(
                  'ti text-lg',
                  collapsed ? 'ti-layout-sidebar-left-expand' : 'ti-layout-sidebar-left-collapse',
                )}
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        </div>
      </>
    );
  };

  return (
    <ResizableSidebar
      className={cn(
        'border-r border-border bg-surface-1 [&_button]:cursor-pointer [&_a]:cursor-pointer',
        className,
      )}
      defaultWidth={280}
      minWidth={240}
      maxWidth={420}
      aria-label={t('runtime.mainNavigation')}
      collapsed={folded}
      collapsedWidth={64}
      onCollapse={() => setCollapsedTo(true)}
      onExpand={() => setCollapsedTo(false)}
    >
      {(width, dragging) => renderContent(dragging ? width < COMPACT_BELOW : folded)}
    </ResizableSidebar>
  );
}
