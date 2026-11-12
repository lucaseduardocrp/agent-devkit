import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ResizableSidebar } from '../src/components/layout/ResizableSidebar.js';
import { Sidebar } from '../src/components/layout/Sidebar.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type {
  EffectiveAccess,
  ModuleAccess,
  PermissionModule,
} from '../src/features/workspaces/workspace-types.js';

const KEY = 'adk.sidebar.collapsed';

function accessWith(modules: Partial<Record<PermissionModule, ModuleAccess>>): EffectiveAccess {
  return { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, ...modules } };
}

const noAccess = (except: Partial<Record<PermissionModule, ModuleAccess>> = {}) =>
  accessWith({
    ...(Object.fromEntries(
      Object.keys(FULL_ACCESS.modules).map((module) => [module, 'none']),
    ) as Record<PermissionModule, ModuleAccess>),
    ...except,
  });

const membership = {
  workspace: { id: 'w1', name: 'Meu WS', slug: 'ws', ownerId: 'u1', createdAt: '' },
  member: {
    id: 'm1',
    workspaceId: 'w1',
    userId: 'u1',
    role: 'ADMIN' as const,
    permissions: {},
    createdAt: '',
  },
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('Sidebar folded to icons', () => {
  it('shows icons named by tooltips that follow hover and focus', () => {
    window.localStorage.setItem(KEY, '1');
    const onSelect = vi.fn();
    render(
      <Sidebar
        activeTab="workspaces"
        onSelectTab={onSelect}
        workspaces={[membership]}
        activeWorkspaceId="w1"
        inboxUnreadCount={4}
      />,
    );
    expect(screen.getByRole('complementary')).toHaveAttribute('data-collapsed', 'true');
    const brain = screen.getByRole('button', { name: 'Cérebro' });

    fireEvent.mouseEnter(brain.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Cérebro');
    fireEvent.mouseLeave(brain.parentElement as HTMLElement);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(brain);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Cérebro');
    fireEvent.blur(brain);
    expect(screen.queryByRole('tooltip')).toBeNull();

    // The workspace icon is named after the active workspace and opens the workspaces page.
    const workspaces = screen.getByTestId('sidebar-workspaces-button');
    fireEvent.mouseEnter(workspaces.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Meu WS');
    fireEvent.click(workspaces);
    expect(onSelect).toHaveBeenCalledWith('workspaces');
    expect(workspaces.className).toContain('bg-[var(--fill-ghost-selected)]');

    // The unread count sits on the icon.
    expect(screen.getByLabelText('4 unread').className).toContain('absolute');
  });

  it('marks the workspaces icon as idle on another page and names it after the default title', () => {
    window.localStorage.setItem(KEY, '1');
    render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} />);
    const workspaces = screen.getByTestId('sidebar-workspaces-button');
    expect(workspaces.className).not.toContain('bg-[var(--fill-ghost-selected)]');
    fireEvent.mouseEnter(workspaces.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Workspaces');
  });

  it('leaves out the line above the first section when the work modules are hidden', () => {
    window.localStorage.setItem(KEY, '1');
    const view = render(
      <PermissionsProvider access={noAccess({ brain: 'view' })}>
        <Sidebar activeTab="brain" onSelectTab={vi.fn()} />
      </PermissionsProvider>,
    );
    expect(view.container.querySelectorAll('nav > div > .border-t').length).toBe(0);
    expect(screen.queryByTestId('sidebar-issues-button')).toBeNull();
  });

  it('unfolds and folds again with the footer button, remembering the choice', () => {
    window.localStorage.setItem(KEY, '1');
    render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} />);
    const toggle = screen.getByTestId('sidebar-collapse-button');
    expect(toggle).toHaveAttribute('aria-label', 'Expandir barra lateral');
    fireEvent.mouseEnter(toggle.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Expandir barra lateral');
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(KEY)).toBe('0');
    expect(screen.getByRole('complementary')).not.toHaveAttribute('data-collapsed');
    expect(screen.getByText('Principal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sidebar-collapse-button'));
    expect(window.localStorage.getItem(KEY)).toBe('1');
    expect(screen.getByRole('complementary')).toHaveAttribute('data-collapsed', 'true');
  });
});

describe('Sidebar storage and sections', () => {
  it('works when storage cannot be read or written', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} />);
    expect(screen.getByRole('complementary')).not.toHaveAttribute('data-collapsed');
    fireEvent.click(screen.getByTestId('sidebar-collapse-button'));
    expect(screen.getByRole('complementary')).toHaveAttribute('data-collapsed', 'true');
  });

  it('toggles the AI and Product groups and opens them when a child is active', () => {
    const view = render(<Sidebar activeTab="agentsMap" onSelectTab={vi.fn()} />);
    expect(screen.getByTestId('sidebar-agents-group-button')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    fireEvent.click(screen.getByTestId('sidebar-agents-group-button'));
    expect(screen.getByTestId('sidebar-agents-group-button')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const product = screen.getByTestId('sidebar-product-button');
    expect(product).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(product);
    expect(product).toHaveAttribute('aria-expanded', 'true');
    view.unmount();

    const notes = render(<Sidebar activeTab="releaseNotes" onSelectTab={vi.fn()} />);
    expect(screen.getByTestId('sidebar-product-button')).toHaveAttribute('aria-expanded', 'true');
    const development = screen.getByTestId('sidebar-development-button');
    expect(development).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(development);
    expect(development).toHaveAttribute('aria-expanded', 'true');
    notes.unmount();

    render(<Sidebar activeTab="developmentReview" onSelectTab={vi.fn()} />);
    expect(screen.getByTestId('sidebar-development-button')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('offers the sign-in-free header when the user is not authenticated', () => {
    render(<Sidebar activeTab="brain" onSelectTab={vi.fn()} isAuthenticated={false} />);
    expect(screen.queryByTestId('sidebar-workspaces-button')).toBeNull();
  });

  it('hides modules the member cannot view, section by section', () => {
    const view = render(
      <PermissionsProvider access={noAccess({ integrations: 'view', brain: 'view' })}>
        <Sidebar activeTab="brain" onSelectTab={vi.fn()} />
      </PermissionsProvider>,
    );
    expect(screen.queryByTestId('sidebar-issues-button')).toBeNull();
    expect(screen.queryByTestId('sidebar-agents-group-button')).toBeNull();
    expect(screen.queryByTestId('sidebar-product-button')).toBeNull();
    expect(screen.queryByTestId('sidebar-development-button')).toBeNull();
    expect(screen.queryByText('Testes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Integrações' })).toBeInTheDocument();
    view.unmount();

    // Notifications are part of the integrations module: with only another module, none shows.
    render(
      <PermissionsProvider access={noAccess({ testplans: 'view' })}>
        <Sidebar activeTab="testplans" onSelectTab={vi.fn()} />
      </PermissionsProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Integrações' })).toBeNull();
    expect(screen.queryByTestId('sidebar-notifications-button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Planos de Teste' })).toBeInTheDocument();
  });

  it('shows each group alone when it is the only one allowed', () => {
    const view = render(
      <PermissionsProvider access={noAccess({ design: 'view' })}>
        <Sidebar activeTab="design" onSelectTab={vi.fn()} />
      </PermissionsProvider>,
    );
    expect(screen.getByTestId('sidebar-design-button')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-spec-button')).toBeNull();
    view.unmount();

    render(
      <PermissionsProvider access={noAccess({ e2e: 'view' })}>
        <Sidebar activeTab="e2e" onSelectTab={vi.fn()} />
      </PermissionsProvider>,
    );
    expect(screen.getByTestId('sidebar-e2e-button')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-e2eSources-button')).toHaveTextContent('Sources');
  });
});

describe('ResizableSidebar released twice in one batch', () => {
  it('falls back to the width the drag started from on the second release', () => {
    render(
      <ResizableSidebar data-testid="sidebar" defaultWidth={300}>
        Content
      </ResizableSidebar>,
    );
    const handle = screen.getByRole('separator');
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 300 }));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
      window.dispatchEvent(new MouseEvent('pointercancel'));
    });
    expect(screen.getByTestId('sidebar').style.width).toBe('300px');
  });
});
