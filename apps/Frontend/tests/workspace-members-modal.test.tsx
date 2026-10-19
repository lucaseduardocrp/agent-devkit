import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMembersModal } from '../src/features/workspaces/WorkspaceMembersModal.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';

describe('WorkspaceMembersModal', () => {
  const mockMembers: readonly WorkspaceMember[] = [
    {
      id: 'm-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      role: 'ADMIN',
      permissions: { canManageMembers: true },
      createdAt: '2026-01-01',
      user: { id: 'u-1', name: 'Owner User', email: 'owner@example.com' },
    },
    {
      id: 'm-2',
      workspaceId: 'ws-1',
      userId: 'u-2',
      role: 'MEMBER',
      permissions: {},
      createdAt: '2026-01-02',
      user: { id: 'u-2', name: 'Collab User', email: 'collab@example.com' },
    },
    {
      id: 'm-3',
      workspaceId: 'ws-1',
      userId: 'u-3',
      role: 'VIEWER',
      permissions: {},
      createdAt: '2026-01-03',
      user: { id: 'u-3', name: '', email: 'guest@example.com' },
    },
  ];

  const defaultDeleteWorkspace = vi.fn();

  it('renders nothing when isOpen is false', () => {
    const apiClient = new ApiClient();
    const { container } = render(
      <WorkspaceMembersModal
        isOpen={false}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('loads and displays members when open', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    expect(screen.getByText('Membros')).toBeInTheDocument();
    expect(screen.getByText('Workspace Test')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Owner User')).toBeInTheDocument();
      expect(screen.getByText('Collab User')).toBeInTheDocument();
      expect(screen.getByText('guest@example.com')).toBeInTheDocument();
      expect(screen.getByText('Você')).toBeInTheDocument();
    });
  });

  it('handles load error', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockRejectedValue(new Error('Network error'));

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('invites a new member successfully', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);
    const addSpy = vi.spyOn(apiClient, 'addWorkspaceMember').mockResolvedValue({
      id: 'm-new',
      workspaceId: 'ws-1',
      userId: 'u-new',
      role: 'INTEGRATOR',
      permissions: {},
      createdAt: '',
    });

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Owner User')).toBeInTheDocument();
    });

    const emailInput = screen.getByPlaceholderText('email@exemplo.com');
    const roleSelect = screen.getByLabelText('Função');
    const submitBtn = screen.getByRole('button', { name: /adicionar/i });

    fireEvent.change(emailInput, { target: { value: 'new@example.com' } });
    fireEvent.change(roleSelect, { target: { value: 'INTEGRATOR' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalledWith('ws-1', {
        email: 'new@example.com',
        role: 'INTEGRATOR',
      });
    });
  });

  it('validates empty email and handles invite error', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);
    vi.spyOn(apiClient, 'addWorkspaceMember').mockRejectedValue(new Error('User already exists'));

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Owner User')).toBeInTheDocument();
    });

    // Empty email
    const submitBtn = screen.getByRole('button', { name: /adicionar/i });
    fireEvent.click(submitBtn);
    expect(screen.getByText('E-mail é obrigatório.')).toBeInTheDocument();

    // Invite error
    const emailInput = screen.getByPlaceholderText('email@exemplo.com');
    fireEvent.change(emailInput, { target: { value: 'existing@example.com' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('User already exists')).toBeInTheDocument();
    });
  });

  it('updates member role and handles role change error', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);
    const updateSpy = vi.spyOn(apiClient, 'updateWorkspaceMember').mockResolvedValue({
      id: 'm-2',
      workspaceId: 'ws-1',
      userId: 'u-2',
      role: 'ADMIN',
      permissions: {},
      createdAt: '',
    });

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Collab User')).toBeInTheDocument();
    });

    const collabSelect = screen.getByLabelText('Função Collab User');
    fireEvent.change(collabSelect, { target: { value: 'ADMIN' } });

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('ws-1', 'm-2', { role: 'ADMIN' });
    });

    // Handle update error
    updateSpy.mockRejectedValueOnce(new Error('Cannot change role'));
    fireEvent.change(collabSelect, { target: { value: 'VIEWER' } });

    await waitFor(() => {
      expect(screen.getByText('Cannot change role')).toBeInTheDocument();
    });
  });

  it('removes member and handles removal error', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);
    const removeSpy = vi.spyOn(apiClient, 'removeWorkspaceMember').mockResolvedValue({
      success: true,
    });

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Collab User')).toBeInTheDocument();
    });

    const removeBtn = screen.getByLabelText('Remover Membro Collab User');
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('ws-1', 'm-2');
    });

    // Handle removal error
    removeSpy.mockRejectedValueOnce(new Error('Cannot remove last admin'));
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.getByText('Cannot remove last admin')).toBeInTheDocument();
    });
  });

  it('closes modal on close button and Escape key', () => {
    const onClose = vi.fn();
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue([]);

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={onClose}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    fireEvent.click(screen.getByLabelText('Fechar modal'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('handles member without user object and fallback error messages', async () => {
    const apiClient = new ApiClient();
    const memberNoUser: WorkspaceMember = {
      id: 'm-anon',
      workspaceId: 'ws-1',
      userId: 'u-anon',
      role: 'VIEWER',
      permissions: {},
      createdAt: '',
    };
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue([memberNoUser]);

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Membro')).toBeInTheDocument();
    });

    // Update with non-Error rejection
    vi.spyOn(apiClient, 'updateWorkspaceMember').mockRejectedValue('Simple string');
    fireEvent.change(screen.getByLabelText('Função Membro'), { target: { value: 'ADMIN' } });
    await waitFor(() => {
      expect(screen.getByText('Falha ao atualizar papel.')).toBeInTheDocument();
    });

    // Remove with non-Error rejection
    vi.spyOn(apiClient, 'removeWorkspaceMember').mockRejectedValue('Simple string');
    fireEvent.click(screen.getByLabelText('Remover Membro Membro'));
    await waitFor(() => {
      expect(screen.getByText('Falha ao remover membro.')).toBeInTheDocument();
    });

    // Add with non-Error rejection
    vi.spyOn(apiClient, 'addWorkspaceMember').mockRejectedValue('Simple string');
    fireEvent.change(screen.getByPlaceholderText('email@exemplo.com'), {
      target: { value: 'test@anon.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /adicionar/i }));
    await waitFor(() => {
      expect(screen.getByText('Falha ao adicionar membro.')).toBeInTheDocument();
    });
  });

  it('handles non-Error thrown on initial load', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockRejectedValue('Raw string rejection');

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={defaultDeleteWorkspace}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Falha ao carregar membros.')).toBeInTheDocument();
    });
  });

  it('renders danger zone for admin and handles confirmation, cancellation, and deletion', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={deleteSpy}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Zona de Perigo')).toBeInTheDocument();
    });

    // Click "Excluir Workspace" to show confirmation
    const deleteBtn = screen.getByRole('button', { name: 'Excluir workspace' });
    fireEvent.click(deleteBtn);

    const confirmBtn = screen.getByRole('button', { name: 'Confirmar exclusão' });
    const cancelBtn = screen.getByRole('button', { name: 'Cancelar exclusão' });
    expect(confirmBtn).toBeInTheDocument();

    // Cancel resets confirmation
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole('button', { name: 'Confirmar exclusão' })).not.toBeInTheDocument();

    // Open confirmation again and confirm
    fireEvent.click(screen.getByRole('button', { name: 'Excluir workspace' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      { target: { value: 'Workspace Test' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir workspace' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('ws-1');
    });

    // When user is not admin (u-2), danger zone should not appear
    rerender(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-2"
        apiClient={apiClient}
        onDeleteWorkspace={deleteSpy}
      />,
    );

    expect(screen.queryByText('Zona de Perigo')).not.toBeInTheDocument();
  });

  it('handles delete workspace errors gracefully', async () => {
    const apiClient = new ApiClient();
    vi.spyOn(apiClient, 'getWorkspaceMembers').mockResolvedValue(mockMembers);
    const deleteSpy = vi.fn().mockRejectedValueOnce(new Error('Network error on delete'));

    render(
      <WorkspaceMembersModal
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={apiClient}
        onDeleteWorkspace={deleteSpy}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Zona de Perigo')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Excluir workspace' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      { target: { value: 'Workspace Test' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir workspace' }));

    await waitFor(() => {
      expect(screen.getByText('Network error on delete')).toBeInTheDocument();
    });

    // Test non-Error rejection fallback
    deleteSpy.mockRejectedValueOnce('Raw string error');
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      { target: { value: 'Workspace Test' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir workspace' }));

    await waitFor(() => {
      expect(screen.getByText('Falha ao excluir workspace.')).toBeInTheDocument();
    });
  });
});
