import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLayout } from '../src/components/layout/WorkspaceLayout.js';

describe('WorkspaceLayout', () => {
  it('renders sidebar, topbar, and children layout', () => {
    const onSelectTab = vi.fn();
    const { getByText } = render(
      <WorkspaceLayout activeTab="brain" onSelectTab={onSelectTab}>
        <div data-testid="child-content">Main Child Content</div>
      </WorkspaceLayout>,
    );

    expect(getByText('Agent DevKit')).toBeInTheDocument();
    expect(getByText('Main Child Content')).toBeInTheDocument();
  });

  it('applies standard scrollable padding when activeTab is not brain', () => {
    const onSelectTab = vi.fn();
    const { getByRole } = render(
      <WorkspaceLayout activeTab="connect" onSelectTab={onSelectTab}>
        <div>Connect Content</div>
      </WorkspaceLayout>,
    );

    const main = getByRole('main');
    expect(main).toHaveClass('overflow-y-auto');
    expect(main).toHaveClass('p-5');
    expect(main).not.toHaveClass('overflow-hidden');
    expect(main).not.toHaveClass('p-0');
  });

  it('forwards workspace props to Sidebar', () => {
    const mockWorkspaces = [
      {
        workspace: { id: 'w1', name: 'Layout WS', slug: 'l-ws', ownerId: 'u1', createdAt: '' },
        member: {
          id: 'm1',
          workspaceId: 'w1',
          userId: 'u1',
          role: 'ADMIN' as const,
          permissions: {},
          createdAt: '',
        },
      },
    ];
    const { getByText } = render(
      <WorkspaceLayout
        activeTab="brain"
        onSelectTab={vi.fn()}
        isAuthenticated={true}
        workspaces={mockWorkspaces}
        activeWorkspaceId="w1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      >
        <div>Content</div>
      </WorkspaceLayout>,
    );

    expect(getByText('Layout WS')).toBeInTheDocument();
  });
});
