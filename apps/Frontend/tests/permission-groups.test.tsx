import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';
import type {
  PermissionGroup,
  UserWorkspaceMembership,
  WorkspaceMember,
} from '../src/features/workspaces/workspace-types.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const workspace = { id: 'ws', name: 'Squad', slug: 'squad', ownerId: 'u-admin', createdAt: '' };
const member = (
  id: string,
  role: WorkspaceMember['role'],
  groupIds: string[] = [],
  permissions: WorkspaceMember['permissions'] = {},
): WorkspaceMember => ({
  id: `m-${id}`,
  workspaceId: 'ws',
  userId: `u-${id}`,
  role,
  permissions,
  createdAt: '',
  groupIds,
  user: { id: `u-${id}`, name: `User ${id}`, email: `${id}@corp.com` },
});
const editors: PermissionGroup = {
  id: 'g-editors',
  workspaceId: 'ws',
  name: 'Editores',
  description: 'Conteúdo',
  modules: { pbis: 'delete', brain: 'edit', testplans: 'view' },
  memberIds: ['m-1'],
  createdAt: '',
  updatedAt: '',
};
const readers: PermissionGroup = {
  ...editors,
  id: 'g-readers',
  name: 'Leitores',
  description: '',
  modules: {},
  memberIds: [],
};

function setup(
  membership: UserWorkspaceMembership,
  groups: PermissionGroup[] = [editors, readers],
  members: WorkspaceMember[] = [
    member('admin', 'ADMIN'),
    member('1', 'MEMBER', ['g-editors']),
    member('2', 'VIEWER'),
  ],
) {
  const client = new ApiClient();
  vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue(members);
  vi.spyOn(client, 'getPermissionGroups').mockResolvedValue(groups);
  const onWorkspaceRenamed = vi.fn();
  const view = render(
    <I18nProvider initialLocale="pt-BR">
      <SettingsView
        apiClient={client}
        activeMembership={membership}
        currentUserId={membership.member.userId}
        onWorkspaceRenamed={onWorkspaceRenamed}
      />
    </I18nProvider>,
  );
  return { client, view, onWorkspaceRenamed };
}

const adminMembership: UserWorkspaceMembership = {
  workspace,
  member: member('admin', 'ADMIN'),
  access: FULL_ACCESS,
};

describe('Permission groups in settings', () => {
  it('creates, edits and deletes permission groups with cumulative operations', async () => {
    const { client, view } = setup(adminMembership);
    const save = vi
      .spyOn(client, 'savePermissionGroup')
      .mockRejectedValueOnce(new Error('Nome em uso'))
      .mockResolvedValue(editors);
    const remove = vi
      .spyOn(client, 'deletePermissionGroup')
      .mockRejectedValueOnce('offline')
      .mockResolvedValue(undefined);

    fireEvent.click(view.getByTestId('settings-section-groups'));
    const panel = await view.findByTestId('permission-groups-panel');
    expect(await within(panel).findByText('Editores')).toBeInTheDocument();
    expect(within(panel).getByText(/PBIs: Excluir · Brain: Criar\/Editar/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Novo grupo' }));
    const form = within(panel).getByRole('form', { name: 'Novo grupo' });
    fireEvent.change(within(form).getByLabelText('Nome do grupo'), { target: { value: 'QA' } });
    fireEvent.change(within(form).getByLabelText('Descrição'), { target: { value: 'Testers' } });
    // Checking delete also grants view and edit; unchecking view clears the module.
    fireEvent.click(within(form).getByLabelText('Excluir em Planos de teste'));
    expect(
      within(form).getByLabelText<HTMLInputElement>('Visualizar em Planos de teste').checked,
    ).toBe(true);
    fireEvent.click(within(form).getByLabelText('Visualizar em PBIs'));
    fireEvent.click(within(form).getByLabelText('Visualizar em PBIs'));
    expect(within(form).getByLabelText<HTMLInputElement>('Visualizar em PBIs').checked).toBe(false);
    fireEvent.click(within(form).getByLabelText('User 1'));
    fireEvent.click(within(form).getByLabelText('User 2'));
    fireEvent.click(within(form).getByLabelText('User 2'));

    fireEvent.click(within(form).getByRole('button', { name: 'Salvar grupo' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Nome em uso');
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar grupo' }));
    expect(await within(panel).findByText('Grupo salvo.')).toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith(
      'ws',
      {
        name: 'QA',
        description: 'Testers',
        modules: { testplans: 'delete', pbis: 'none' },
        memberIds: ['m-1'],
      },
      undefined,
    );

    fireEvent.click(within(panel).getByRole('button', { name: 'Editar grupo Editores' }));
    const editForm = within(panel).getByRole('form', { name: 'Editar grupo' });
    expect(within(editForm).getByLabelText<HTMLInputElement>('Nome do grupo').value).toBe(
      'Editores',
    );
    fireEvent.click(within(editForm).getByRole('button', { name: 'Cancelar' }));

    fireEvent.click(within(panel).getByRole('button', { name: 'Editar grupo Editores' }));
    fireEvent.click(
      within(within(panel).getByRole('form', { name: 'Editar grupo' })).getByRole('button', {
        name: 'Salvar grupo',
      }),
    );
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith('ws', expect.any(Object), 'g-editors'),
    );

    fireEvent.click(await within(panel).findByRole('button', { name: 'Excluir grupo Leitores' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    expect(await within(panel).findByText('Não foi possível salvar.')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Excluir grupo Leitores' }));
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Excluir grupo Leitores' }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    expect(await within(panel).findByText('Grupo excluído.')).toBeInTheDocument();
    expect(remove).toHaveBeenLastCalledWith('ws', 'g-readers');
  });

  it('shows an empty state when the workspace has no groups', async () => {
    const { view } = setup(adminMembership, []);
    fireEvent.click(view.getByTestId('settings-section-groups'));
    expect(await view.findByText('Nenhum grupo de permissão neste workspace.')).toBeInTheDocument();
  });

  it('edits workspace permissions and groups of a member and invites into groups', async () => {
    const { client, view } = setup(adminMembership);
    const update = vi
      .spyOn(client, 'updateWorkspaceMember')
      .mockRejectedValueOnce('offline')
      .mockResolvedValue(member('1', 'MEMBER'));
    const add = vi.spyOn(client, 'addWorkspaceMember').mockResolvedValue(member('3', 'MEMBER'));
    fireEvent.click(view.getByTestId('settings-section-members'));

    const row = await view.findByTestId('member-row-m-1');
    expect(await within(row).findByText('Editores')).toBeInTheDocument();
    expect(within(view.getByTestId('member-row-m-2')).getByText(/Sem grupos/)).toBeInTheDocument();
    expect(
      within(view.getByTestId('member-row-m-admin')).getByText(/acesso total/),
    ).toBeInTheDocument();
    expect(
      within(view.getByTestId('member-row-m-admin')).queryByRole('button', { name: /Permissões/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Permissões User 1' }));
    const editor = view.getByTestId('member-access-m-1');
    fireEvent.click(within(editor).getByLabelText('Gerenciar grupos de permissão'));
    fireEvent.click(within(editor).getByLabelText('Editores'));
    fireEvent.click(within(editor).getByLabelText('Leitores'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar' }));
    expect(await view.findByText('Não foi possível salvar.')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar' }));
    expect(await view.findByText('Permissões atualizadas.')).toBeInTheDocument();
    expect(update).toHaveBeenLastCalledWith('ws', 'm-1', {
      permissions: { manageGroups: true },
      groupIds: ['g-readers'],
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Permissões User 1' }));
    fireEvent.click(
      within(view.getByTestId('member-access-m-1')).getByRole('button', { name: 'Cancelar' }),
    );
    expect(view.queryByTestId('member-access-m-1')).not.toBeInTheDocument();

    fireEvent.change(view.getByPlaceholderText('email@exemplo.com'), {
      target: { value: 'new@corp.com' },
    });
    const invite = view.getByPlaceholderText('email@exemplo.com').closest('form')!;
    fireEvent.click(within(invite).getByLabelText('Leitores'));
    fireEvent.click(within(invite).getByLabelText('Editores'));
    fireEvent.click(within(invite).getByLabelText('Editores'));
    fireEvent.click(within(invite).getByRole('button', { name: /adicionar/i }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('ws', {
        email: 'new@corp.com',
        role: 'MEMBER',
        groupIds: ['g-readers'],
      }),
    );
  });

  it('renames the workspace when allowed and reports failures', async () => {
    const { client, view, onWorkspaceRenamed } = setup(adminMembership);
    const rename = vi
      .spyOn(client, 'renameWorkspace')
      .mockRejectedValueOnce(new Error('Nome inválido'))
      .mockRejectedValueOnce('offline')
      .mockResolvedValue({ ...workspace, name: 'Novo' });
    fireEvent.click(view.getByTestId('settings-section-workspace'));
    const input = view.getByLabelText('Nome do workspace');
    expect((view.getByRole('button', { name: 'Renomear' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: ' Novo ' } });
    fireEvent.click(view.getByRole('button', { name: 'Renomear' }));
    expect(await view.findByText('Nome inválido')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Renomear' }));
    expect(await view.findByText('Não foi possível salvar.')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Renomear' }));
    expect(await view.findByText('Workspace renomeado.')).toBeInTheDocument();
    expect(rename).toHaveBeenLastCalledWith('ws', 'Novo');
    expect(onWorkspaceRenamed).toHaveBeenCalledWith({ ...workspace, name: 'Novo' });
  });

  it('hides workspace actions the member is not allowed to perform', async () => {
    const limited: UserWorkspaceMembership = {
      workspace,
      member: member('1', 'MEMBER', [], { manageRoles: true }),
      access: {
        modules: FULL_ACCESS.modules,
        workspace: {
          ...FULL_ACCESS.workspace,
          editWorkspace: false,
          deleteWorkspace: false,
          addMembers: false,
          removeMembers: false,
          manageGroups: false,
          manageCosts: false,
        },
      },
    };
    const { client, view } = setup(limited);
    vi.spyOn(client, 'updateWorkspaceMember').mockResolvedValue(member('2', 'VIEWER'));
    expect(view.queryByTestId('settings-section-groups')).not.toBeInTheDocument();
    fireEvent.click(view.getByTestId('settings-section-workspace'));
    expect(view.queryByLabelText('Nome do workspace')).not.toBeInTheDocument();
    expect(view.queryByTestId('workspace-danger-zone')).not.toBeInTheDocument();

    fireEvent.click(view.getByTestId('settings-section-members'));
    expect(view.queryByPlaceholderText('email@exemplo.com')).not.toBeInTheDocument();
    const adminRow = await view.findByTestId('member-row-m-admin');
    // Administrators cannot be changed or removed by other members.
    expect(within(adminRow).queryByRole('combobox')).not.toBeInTheDocument();
    const viewerRow = view.getByTestId('member-row-m-2');
    expect(within(viewerRow).queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
    expect(
      within(viewerRow).queryByRole('option', { name: 'Administrador' }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(viewerRow).getByRole('button', { name: 'Permissões User 2' }));
    const editor = view.getByTestId('member-access-m-2');
    expect(within(editor).queryByText('Grupos')).not.toBeInTheDocument();
    expect(within(editor).getByLabelText<HTMLInputElement>('Excluir workspace').disabled).toBe(
      true,
    );
    fireEvent.click(within(editor).getByLabelText('Gerenciar papéis e permissões'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.updateWorkspaceMember).toHaveBeenCalledWith('ws', 'm-2', {
        permissions: { manageRoles: true },
      }),
    );
  });

  it('only manages groups when roles cannot be changed, and hides groups that failed to load', async () => {
    const groupsOnly: UserWorkspaceMembership = {
      workspace,
      member: member('1', 'MEMBER'),
      access: {
        modules: FULL_ACCESS.modules,
        workspace: { ...FULL_ACCESS.workspace, manageRoles: false },
      },
    };
    const { client, view } = setup(groupsOnly, [], [member('2', 'VIEWER')]);
    vi.mocked(client.getPermissionGroups).mockRejectedValue(new Error('down'));
    vi.spyOn(client, 'updateWorkspaceMember').mockResolvedValue(member('2', 'VIEWER'));
    fireEvent.click(view.getByTestId('settings-section-members'));
    const row = await view.findByTestId('member-row-m-2');
    fireEvent.click(within(row).getByRole('button', { name: 'Permissões User 2' }));
    const editor = view.getByTestId('member-access-m-2');
    expect(within(editor).queryByText('Permissões do workspace')).not.toBeInTheDocument();
    expect(
      within(editor).getByText('Nenhum grupo de permissão neste workspace.'),
    ).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(client.updateWorkspaceMember).toHaveBeenCalledWith('ws', 'm-2', { groupIds: [] }),
    );
  });
});
