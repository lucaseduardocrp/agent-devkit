import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSwitcher } from '../src/features/workspaces/WorkspaceSwitcher.js';
import type { UserWorkspaceMembership } from '../src/features/workspaces/workspace-types.js';

describe('WorkspaceSwitcher', () => {
  const mockWorkspaces: readonly UserWorkspaceMembership[] = [
    {
      workspace: {
        id: 'ws-1',
        name: 'Workspace Alpha',
        slug: 'alpha',
        ownerId: 'u-1',
        createdAt: '2026-01-01',
      },
      member: {
        id: 'm-1',
        workspaceId: 'ws-1',
        userId: 'u-1',
        role: 'ADMIN',
        permissions: { canManageMembers: true, canManageIntegrations: true },
        createdAt: '2026-01-01',
      },
    },
    {
      workspace: {
        id: 'ws-2',
        name: 'Workspace Beta',
        slug: 'beta',
        ownerId: 'u-2',
        createdAt: '2026-01-02',
      },
      member: {
        id: 'm-2',
        workspaceId: 'ws-2',
        userId: 'u-1',
        role: 'VIEWER',
        permissions: { canManageMembers: false },
        createdAt: '2026-01-02',
      },
    },
    {
      workspace: {
        id: 'ws-3',
        name: 'Workspace Gamma',
        slug: 'gamma',
        ownerId: 'u-3',
        createdAt: '2026-01-03',
      },
      member: {
        id: 'm-3',
        workspaceId: 'ws-3',
        userId: 'u-1',
        role: 'INTEGRATOR',
        permissions: { canManageIntegrations: true },
        createdAt: '2026-01-03',
      },
    },
    {
      workspace: {
        id: 'ws-4',
        name: 'Workspace Delta',
        slug: 'delta',
        ownerId: 'u-4',
        createdAt: '2026-01-04',
      },
      member: {
        id: 'm-4',
        workspaceId: 'ws-4',
        userId: 'u-1',
        role: 'MEMBER',
        permissions: {},
        createdAt: '2026-01-04',
      },
    },
  ];

  it('renders active workspace and role badge', () => {
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByText('Workspace Alpha')).toBeInTheDocument();
    expect(screen.getByText('Administrador')).toBeInTheDocument();
  });

  it('renders fallback when no active workspace is selected', () => {
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByText('Selecione o Workspace')).toBeInTheDocument();
  });

  it('toggles dropdown and allows selecting another workspace', () => {
    const onSelect = vi.fn();
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={onSelect}
        onCreateWorkspace={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: /selecionar workspace/i });
    fireEvent.click(trigger);

    expect(screen.getByText('Workspace Beta')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Workspace Beta'));

    expect(onSelect).toHaveBeenCalledWith('ws-2');
  });

  it('creates a new workspace successfully', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /selecionar workspace/i }));
    fireEvent.click(screen.getByRole('button', { name: /novo workspace/i }));

    const input = screen.getByPlaceholderText('Nome do workspace...');
    fireEvent.change(input, { target: { value: 'New Enterprise' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith('New Enterprise');
    });
  });

  it('validates empty name and handles creation error', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('Slug collision'));
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /selecionar workspace/i }));
    fireEvent.click(screen.getByRole('button', { name: /novo workspace/i }));

    // Submit empty
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    expect(screen.getByText('Nome do workspace é obrigatório.')).toBeInTheDocument();

    // Submit with value that rejects
    const input = screen.getByPlaceholderText('Nome do workspace...');
    fireEvent.change(input, { target: { value: 'Colliding WS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() => {
      expect(screen.getByText('Slug collision')).toBeInTheDocument();
    });

    // Cancel creation
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByPlaceholderText('Nome do workspace...')).not.toBeInTheDocument();
  });

  it('handles non-Error thrown during workspace creation', async () => {
    const onCreateUnknown = vi.fn().mockRejectedValue('Simple string error');
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={onCreateUnknown}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /selecionar workspace/i }));
    fireEvent.click(screen.getByRole('button', { name: /novo workspace/i }));

    const input = screen.getByPlaceholderText('Nome do workspace...');
    fireEvent.change(input, { target: { value: 'Another WS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() => {
      expect(screen.getByText('Erro ao criar workspace.')).toBeInTheDocument();
    });
  });

  it('triggers onOpenMembersModal when clicked by admin', () => {
    const onOpen = vi.fn();
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenMembersModal={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /selecionar workspace/i }));
    const manageBtn = screen.getByRole('button', { name: /gerenciar membros/i });
    fireEvent.click(manageBtn);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders correct role badges for INTEGRATOR, VIEWER, and MEMBER', () => {
    const { rerender } = render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-2"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByText('Visualizador')).toBeInTheDocument();

    rerender(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-3"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByText('Integrador')).toBeInTheDocument();

    rerender(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-4"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByText('Membro')).toBeInTheDocument();
  });

  it('renders loading skeleton when isLoading is true', () => {
    render(
      <WorkspaceSwitcher
        workspaces={mockWorkspaces}
        activeWorkspaceId="ws-1"
        onSelectWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
        isLoading={true}
      />,
    );

    expect(screen.getByTestId('workspace-switcher-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Workspace Alpha')).not.toBeInTheDocument();
  });
});
