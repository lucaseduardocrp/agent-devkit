import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { I18nProvider } from '../src/lib/i18n/index.js';
import { ApiClient } from '../src/lib/api-client.js';
import type { UserWorkspaceMembership } from '../src/features/workspaces/workspace-types.js';

describe('SettingsView', () => {
  const adminMembership: UserWorkspaceMembership = {
    workspace: {
      id: 'ws-active-1',
      name: 'Engineering Workspace',
      slug: 'eng-ws',
      ownerId: 'usr-admin-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    member: {
      id: 'm-admin-1',
      workspaceId: 'ws-active-1',
      userId: 'usr-admin-1',
      role: 'ADMIN',
      permissions: { canManageMembers: true },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };

  const viewerMembership: UserWorkspaceMembership = {
    workspace: {
      id: 'ws-viewer-1',
      name: 'Viewer Workspace',
      slug: 'viewer-ws',
      ownerId: 'usr-admin-1',
      createdAt: '',
    },
    member: {
      id: 'm-viewer-1',
      workspaceId: 'ws-viewer-1',
      userId: 'usr-viewer-1',
      role: 'VIEWER',
      permissions: {},
      createdAt: '',
    },
  };

  it('renders without apiClient and omits legacy operational cards', () => {
    const { getByText, queryByText } = render(<SettingsView />);

    expect(getByText('Nenhum workspace ativo selecionado.')).toBeInTheDocument();
    expect(queryByText('Configuração de Tenant e Isolamento')).not.toBeInTheDocument();
    expect(queryByText('Diagnóstico do Backend')).not.toBeInTheDocument();
  });

  it('renders active workspace details and loads members list', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([
      {
        id: 'm-1',
        workspaceId: 'ws-active-1',
        userId: 'usr-admin-1',
        role: 'ADMIN',
        permissions: {},
        createdAt: '',
        user: { id: 'usr-admin-1', name: 'Admin Ana', email: 'ana@admin.com' },
      },
      {
        id: 'm-2',
        workspaceId: 'ws-active-1',
        userId: 'usr-2',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
        user: { id: 'usr-2', name: '', email: 'guest@admin.com' },
      },
      {
        id: 'm-3',
        workspaceId: 'ws-active-1',
        userId: 'usr-3',
        role: 'INTEGRATOR',
        permissions: {},
        createdAt: '',
      },
    ]);

    const { getByText, getAllByText, findByText } = render(
      <SettingsView
        apiClient={client}
        activeMembership={adminMembership}
        currentUserId="usr-admin-1"
      />,
    );

    expect(getAllByText('Engineering Workspace').length).toBeGreaterThan(0);
    expect(getByText('eng-ws')).toBeInTheDocument();
    expect(getByText(/Função:/)).toBeInTheDocument();

    expect(await findByText('Admin Ana')).toBeInTheDocument();
    expect(getByText('Você')).toBeInTheDocument();
    expect(getByText('guest@admin.com')).toBeInTheDocument();
    expect(getAllByText('Membro').length).toBeGreaterThan(0);
  });

  it('handles member loading failure with Error and fallback string', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers')
      .mockRejectedValueOnce(new Error('Erro de permissão'))
      .mockRejectedValueOnce('Falha não identificada');

    const { rerender, findByText } = render(
      <SettingsView apiClient={client} activeMembership={adminMembership} />,
    );

    expect(await findByText('Erro de permissão')).toBeInTheDocument();

    rerender(
      <SettingsView
        apiClient={client}
        activeMembership={{
          ...adminMembership,
          workspace: { ...adminMembership.workspace, id: 'ws-active-2' },
        }}
      />,
    );

    expect(await findByText('Falha ao carregar membros.')).toBeInTheDocument();
  });

  it('validates empty email on member invite submit', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);

    const { getByRole, findByText } = render(
      <SettingsView apiClient={client} activeMembership={adminMembership} />,
    );

    const addBtn = await getByRole('button', { name: /adicionar/i });
    fireEvent.click(addBtn);

    expect(await findByText('E-mail é obrigatório.')).toBeInTheDocument();
  });

  it('adds member successfully and handles invite error', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    const getMembersSpy = vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    const addMemberSpy = vi.spyOn(client, 'addWorkspaceMember').mockResolvedValue({
      id: 'm-new',
      workspaceId: 'ws-active-1',
      userId: 'usr-new',
      role: 'MEMBER',
      permissions: {},
      createdAt: '',
    });

    const { getByPlaceholderText, getByRole, findByText } = render(
      <SettingsView apiClient={client} activeMembership={adminMembership} />,
    );

    const emailInput = getByPlaceholderText('email@exemplo.com');
    fireEvent.change(emailInput, { target: { value: 'novomembro@corp.com' } });
    fireEvent.click(getByRole('button', { name: /adicionar/i }));

    expect(await findByText('Membro adicionado com sucesso.')).toBeInTheDocument();
    expect(addMemberSpy).toHaveBeenCalledWith('ws-active-1', {
      email: 'novomembro@corp.com',
      role: 'MEMBER',
    });
    expect(getMembersSpy).toHaveBeenCalledTimes(2);

    // Test error branch
    addMemberSpy.mockRejectedValueOnce(new Error('Usuário já é membro'));
    fireEvent.change(emailInput, { target: { value: 'existente@corp.com' } });
    fireEvent.click(getByRole('button', { name: /adicionar/i }));

    expect(await findByText('Usuário já é membro')).toBeInTheDocument();
  });

  it('allows admin to update member role and handles role update error', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([
      {
        id: 'm-target',
        workspaceId: 'ws-active-1',
        userId: 'usr-target',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
        user: { id: 'usr-target', name: 'Target User', email: 'target@corp.com' },
      },
    ]);
    const updateSpy = vi.spyOn(client, 'updateWorkspaceMember').mockResolvedValue({
      id: 'm-target',
      workspaceId: 'ws-active-1',
      userId: 'usr-target',
      role: 'ADMIN',
      permissions: {},
      createdAt: '',
    });

    const { getByLabelText, findByText } = render(
      <SettingsView apiClient={client} activeMembership={adminMembership} />,
    );

    await findByText('Target User');
    const select = getByLabelText('Função Target User');
    fireEvent.change(select, { target: { value: 'ADMIN' } });

    expect(await findByText('Papel do membro atualizado com sucesso.')).toBeInTheDocument();
    expect(updateSpy).toHaveBeenCalledWith('ws-active-1', 'm-target', { role: 'ADMIN' });

    // Test error branch
    updateSpy.mockRejectedValueOnce(new Error('Permissão negada ao alterar'));
    fireEvent.change(select, { target: { value: 'INTEGRATOR' } });
    expect(await findByText('Permissão negada ao alterar')).toBeInTheDocument();
  });

  it('allows admin to remove member and handles remove error', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([
      {
        id: 'm-rem',
        workspaceId: 'ws-active-1',
        userId: 'usr-rem',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
        user: { id: 'usr-rem', name: 'Removable User', email: 'rem@corp.com' },
      },
    ]);
    const removeSpy = vi.spyOn(client, 'removeWorkspaceMember').mockResolvedValue({
      success: true,
    });

    const { getByRole, findByText } = render(
      <SettingsView apiClient={client} activeMembership={adminMembership} />,
    );

    await findByText('Removable User');
    const removeBtn = getByRole('button', { name: 'Remover Removable User' });
    fireEvent.click(removeBtn);

    expect(await findByText('Membro removido com sucesso.')).toBeInTheDocument();
    expect(removeSpy).toHaveBeenCalledWith('ws-active-1', 'm-rem');

    // Test error branch
    removeSpy.mockRejectedValueOnce(new Error('Não é possível remover o único admin'));
    fireEvent.click(removeBtn);
    expect(await findByText('Não é possível remover o único admin')).toBeInTheDocument();
  });

  it('hides admin controls when user is not admin', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([
      {
        id: 'm-v1',
        workspaceId: 'ws-viewer-1',
        userId: 'usr-viewer-1',
        role: 'VIEWER',
        permissions: {},
        createdAt: '',
        user: { id: 'usr-viewer-1', name: 'Viewer User', email: 'viewer@corp.com' },
      },
    ]);

    const { queryByRole, queryByTestId, findByText } = render(
      <SettingsView
        apiClient={client}
        activeMembership={viewerMembership}
        currentUserId="usr-viewer-1"
      />,
    );

    await findByText('Viewer User');
    expect(queryByRole('button', { name: /adicionar/i })).not.toBeInTheDocument();
    expect(queryByRole('button', { name: /remover/i })).not.toBeInTheDocument();
    expect(queryByTestId('workspace-danger-zone')).not.toBeInTheDocument();
  });

  it('handles workspace deletion flow with confirmation, cancellation, and error handling', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);

    const { getByRole, findByText } = render(
      <SettingsView
        apiClient={client}
        activeMembership={adminMembership}
        onDeleteWorkspace={deleteSpy}
      />,
    );

    // Initial button click opens confirmation
    const deleteBtn = getByRole('button', { name: 'Excluir workspace' });
    fireEvent.click(deleteBtn);

    // Cancel deletion
    const cancelBtn = getByRole('button', { name: 'Cancelar exclusão' });
    fireEvent.click(cancelBtn);
    expect(getByRole('button', { name: 'Excluir workspace' })).toBeInTheDocument();

    // Open again and confirm
    fireEvent.click(getByRole('button', { name: 'Excluir workspace' }));
    fireEvent.change(
      getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      {
        target: { value: 'Engineering Workspace' },
      },
    );
    const confirmBtn = getByRole('button', { name: 'Confirmar exclusão' });
    fireEvent.click(confirmBtn);
    fireEvent.click(getByRole('button', { name: 'Excluir workspace' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('ws-active-1');
    });

    // Test error branch with Error and string fallback
    deleteSpy.mockRejectedValueOnce(new Error('Erro ao deletar workspace'));
    fireEvent.change(
      getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      {
        target: { value: 'Engineering Workspace' },
      },
    );
    fireEvent.click(confirmBtn);
    fireEvent.click(getByRole('button', { name: 'Excluir workspace' }));
    expect(await findByText('Erro ao deletar workspace')).toBeInTheDocument();

    deleteSpy.mockRejectedValueOnce('Falha string exclusao');
    fireEvent.change(
      getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      {
        target: { value: 'Engineering Workspace' },
      },
    );
    fireEvent.click(confirmBtn);
    fireEvent.click(getByRole('button', { name: 'Excluir workspace' }));
    expect(await findByText('Falha ao excluir workspace.')).toBeInTheDocument();
  });

  it('allows non-admin member with canManageMembers permission to invite and change role', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
    const addMemberSpy = vi.spyOn(client, 'addWorkspaceMember').mockResolvedValue({
      id: 'm-new-2',
      workspaceId: 'ws-active-1',
      userId: 'usr-new-2',
      role: 'VIEWER',
      permissions: {},
      createdAt: '',
    });

    const managerMembership: UserWorkspaceMembership = {
      workspace: {
        id: 'ws-active-1',
        name: 'Manager WS',
        slug: 'mgr-ws',
        ownerId: 'usr-1',
        createdAt: '',
      },
      member: {
        id: 'm-mgr',
        workspaceId: 'ws-active-1',
        userId: 'usr-mgr',
        role: 'MEMBER',
        permissions: { canManageMembers: true },
        createdAt: '',
      },
    };

    const { getByPlaceholderText, getByRole, getByLabelText, findByText } = render(
      <SettingsView apiClient={client} activeMembership={managerMembership} />,
    );

    // Verify N/A rendered for empty createdAt
    expect(await findByText('N/A')).toBeInTheDocument();

    // Non-administrators can only add Members; access comes from permission groups.
    const roleSelect = getByLabelText('Função');
    expect([...(roleSelect as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      'MEMBER',
    ]);

    const emailInput = getByPlaceholderText('email@exemplo.com');
    fireEvent.change(emailInput, { target: { value: 'viewer@corp.com' } });
    fireEvent.click(getByRole('button', { name: /adicionar/i }));

    expect(await findByText('Membro adicionado com sucesso.')).toBeInTheDocument();
    expect(addMemberSpy).toHaveBeenCalledWith('ws-active-1', {
      email: 'viewer@corp.com',
      role: 'MEMBER',
    });

    // Fallback string error for add member
    addMemberSpy.mockRejectedValueOnce('Falha string adicionar');
    fireEvent.change(emailInput, { target: { value: 'outro@corp.com' } });
    fireEvent.click(getByRole('button', { name: /adicionar/i }));
    expect(await findByText('Falha ao adicionar membro.')).toBeInTheDocument();
  });

  it('handles fallback string errors when updating role or removing member', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getReadiness').mockResolvedValue({ status: 'ready', checks: [] });
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([
      {
        id: 'm-str',
        workspaceId: 'ws-active-1',
        userId: 'usr-str',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
        user: { id: 'usr-str', name: 'String Test', email: 'str@corp.com' },
      },
    ]);
    vi.spyOn(client, 'updateWorkspaceMember').mockRejectedValue('Erro string role');
    vi.spyOn(client, 'removeWorkspaceMember').mockRejectedValue('Erro string remove');

    const { getByLabelText, getByRole, findByText } = render(
      <SettingsView apiClient={client} activeMembership={adminMembership} />,
    );

    await findByText('String Test');

    // Role update error fallback
    const roleSelect = getByLabelText('Função String Test');
    fireEvent.change(roleSelect, { target: { value: 'VIEWER' } });
    expect(await findByText('Falha ao atualizar papel.')).toBeInTheDocument();

    // Remove member error fallback
    const removeBtn = getByRole('button', { name: 'Remover String Test' });
    fireEvent.click(removeBtn);
    expect(await findByText('Falha ao remover membro.')).toBeInTheDocument();
  });

  it('safely handles invite submit without apiClient and delete without onDeleteWorkspace', () => {
    const { getByPlaceholderText, getByRole } = render(
      <SettingsView activeMembership={adminMembership} />,
    );

    // Form submit without apiClient
    const emailInput = getByPlaceholderText('email@exemplo.com');
    fireEvent.change(emailInput, { target: { value: 'noapi@corp.com' } });
    fireEvent.click(getByRole('button', { name: /adicionar/i }));

    // Delete without onDeleteWorkspace
    const deleteBtn = getByRole('button', { name: 'Excluir workspace' });
    fireEvent.click(deleteBtn);
    const confirmBtn = getByRole('button', { name: 'Confirmar exclusão' });
    fireEvent.click(confirmBtn);
  });

  it('renders Regional Preferences and allows switching language from select', () => {
    const { getByTestId } = render(
      <I18nProvider initialLocale="pt-BR">
        <SettingsView />
      </I18nProvider>,
    );

    const card = getByTestId('regional-preferences-card');
    expect(card).toBeInTheDocument();

    const select = getByTestId('settings-locale-select') as HTMLSelectElement;
    expect(select.value).toBe('pt-BR');

    fireEvent.change(select, { target: { value: 'en-US' } });
    expect(select.value).toBe('en-US');
  });
});
