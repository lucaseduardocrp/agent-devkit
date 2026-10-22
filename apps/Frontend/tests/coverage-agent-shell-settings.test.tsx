import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccessTokensPanel } from '../src/features/settings/AccessTokensPanel.js';
import { PermissionGroupsPanel } from '../src/features/settings/PermissionGroupsPanel.js';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { WorkspaceMembersModal } from '../src/features/workspaces/WorkspaceMembersModal.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';
import type {
  PermissionGroup,
  UserWorkspaceMembership,
  WorkspaceMember,
} from '../src/features/workspaces/workspace-types.js';
import { ApiClient, type AccessTokenDto } from '../src/lib/api-client.js';

const token: AccessTokenDto = {
  id: 't1',
  name: 'Claude Code',
  tokenPrefix: 'adk_pat_abc123',
  scope: 'full',
  expiresAt: null,
  lastUsedAt: null,
  createdAt: '2026-09-25T00:00:00.000Z',
};

const workspace = { id: 'ws', name: 'Squad', slug: 'squad', ownerId: 'u-admin', createdAt: '' };
const adminMembership: UserWorkspaceMembership = {
  workspace,
  member: {
    id: 'm-admin',
    workspaceId: 'ws',
    userId: 'u-admin',
    role: 'ADMIN',
    permissions: {},
    createdAt: '',
  },
  access: FULL_ACCESS,
};

function member(id: string, user?: WorkspaceMember['user']): WorkspaceMember {
  return {
    id: `m-${id}`,
    workspaceId: 'ws',
    userId: `u-${id}`,
    role: 'MEMBER',
    permissions: {},
    createdAt: '',
    ...(user ? { user } : {}),
  };
}

const group: PermissionGroup = {
  id: 'g-qa',
  workspaceId: 'ws',
  name: 'QA',
  description: '',
  modules: {},
  memberIds: [],
  createdAt: '',
  updatedAt: '',
};

describe('AccessTokensPanel failures and stale actions', () => {
  it('shows the generic message when tokens cannot be loaded', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockRejectedValue('offline');
    render(<AccessTokensPanel apiClient={client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Falha ao carregar os tokens.');
  });

  it('does not revoke a token once the API client is gone', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockResolvedValue([token]);
    const revoke = vi.spyOn(client, 'revokeAccessToken').mockResolvedValue(undefined);
    const view = render(<AccessTokensPanel apiClient={client} />);
    expect(await view.findByText('Claude Code')).toBeInTheDocument();
    expect(view.getByTestId('token-list')).toHaveTextContent('Nunca expira');

    view.rerender(<AccessTokensPanel />);
    fireEvent.click(view.getByTestId('revoke-token-t1'));
    fireEvent.click(within(view.getByRole('alertdialog')).getByRole('button', { name: 'Revogar' }));

    await waitFor(() => expect(view.getByRole('alertdialog')).toBeInTheDocument());
    expect(revoke).not.toHaveBeenCalled();
    expect(view.queryByText('Token revogado.')).not.toBeInTheDocument();
  });
});

describe('PermissionGroupsPanel', () => {
  it('names members by name, then email, then user id', () => {
    render(
      <PermissionGroupsPanel
        apiClient={new ApiClient()}
        workspaceId="ws"
        groups={[]}
        members={[
          member('ana', { id: 'u-ana', name: 'Ana', email: 'ana@corp.com' }),
          member('bia', { id: 'u-bia', name: '', email: 'bia@corp.com' }),
          member('cid'),
        ]}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Novo grupo' }));

    const form = screen.getByRole('form', { name: 'Novo grupo' });
    expect(within(form).getByLabelText('Ana')).toBeInTheDocument();
    expect(within(form).getByLabelText('bia@corp.com')).toBeInTheDocument();
    expect(within(form).getByLabelText('u-cid')).toBeInTheDocument();
  });

  it('shows the generic message when saving fails without details', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'savePermissionGroup').mockRejectedValue('offline');
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <PermissionGroupsPanel
        apiClient={client}
        workspaceId="ws"
        groups={[]}
        members={[]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Novo grupo' }));
    fireEvent.change(screen.getByLabelText('Nome do grupo'), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar grupo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível salvar.');
    expect(screen.getByRole('form', { name: 'Novo grupo' })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows the server message when deleting a group fails', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'deletePermissionGroup').mockRejectedValue(new Error('Grupo em uso'));
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <PermissionGroupsPanel
        apiClient={client}
        workspaceId="ws"
        groups={[group]}
        members={[]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Excluir grupo QA' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Grupo em uso');
    expect(client.deletePermissionGroup).toHaveBeenCalledWith('ws', 'g-qa');
    expect(onChanged).not.toHaveBeenCalled();
  });
});

function renderSettings(
  props: Partial<Parameters<typeof SettingsView>[0]> = {},
  members: WorkspaceMember[] = [],
) {
  const client = new ApiClient();
  vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue(members);
  vi.spyOn(client, 'getPermissionGroups').mockResolvedValue([]);
  vi.spyOn(client, 'listAccessTokens').mockResolvedValue([]);
  const view = render(
    <SettingsView
      apiClient={client}
      activeMembership={adminMembership}
      currentUserId="u-admin"
      {...props}
    />,
  );
  return { client, view };
}

describe('SettingsView member access and workspace actions', () => {
  it('opens and closes the access editor of a member without stored permissions', async () => {
    // Members stored before permissions and groups existed come without those fields.
    const { permissions: _permissions, ...legacy } = member('old', {
      id: 'u-old',
      name: 'Old Member',
      email: 'old@corp.com',
    });
    const { client, view } = renderSettings({}, [legacy as WorkspaceMember]);
    const update = vi.spyOn(client, 'updateWorkspaceMember').mockRejectedValue('offline');
    fireEvent.click(view.getByTestId('settings-section-members'));

    const row = await view.findByTestId('member-row-m-old');
    const toggle = within(row).getByRole('button', { name: 'Permissões Old Member' });
    fireEvent.click(toggle);
    const editor = view.getByTestId('member-access-m-old');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(editor).getByLabelText<HTMLInputElement>('Gerenciar grupos de permissão').checked,
    ).toBe(false);

    fireEvent.click(within(editor).getByRole('button', { name: 'Salvar' }));
    expect(await view.findByText('Não foi possível salvar.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith('ws', 'm-old', { permissions: {} });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(view.queryByTestId('member-access-m-old')).not.toBeInTheDocument();
  });

  it('does not rename the workspace without an API client', () => {
    const onWorkspaceRenamed = vi.fn();
    const view = render(
      <SettingsView activeMembership={adminMembership} onWorkspaceRenamed={onWorkspaceRenamed} />,
    );
    fireEvent.click(view.getByTestId('settings-section-workspace'));
    fireEvent.change(view.getByLabelText('Nome do workspace'), { target: { value: 'Tribe' } });
    fireEvent.click(view.getByRole('button', { name: 'Renomear' }));

    expect(onWorkspaceRenamed).not.toHaveBeenCalled();
    expect(view.queryByText('Workspace renomeado.')).not.toBeInTheDocument();
  });

  async function openFinalDeletion(view: ReturnType<typeof render>, name: string) {
    fireEvent.click(view.getByTestId('settings-section-workspace'));
    fireEvent.click(view.getByRole('button', { name: 'Excluir workspace' }));
    fireEvent.change(
      view.getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      {
        target: { value: name },
      },
    );
    fireEvent.click(view.getByRole('button', { name: 'Confirmar exclusão' }));
    return view.findByRole('alertdialog', { name: 'Excluir workspace permanentemente?' });
  }

  it('closes the final deletion dialog on cancel without deleting', async () => {
    const onDeleteWorkspace = vi.fn().mockResolvedValue(undefined);
    const { view } = renderSettings({ onDeleteWorkspace });

    const dialog = await openFinalDeletion(view, 'Squad');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    expect(view.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('does nothing on final confirmation when deletion is not supported', async () => {
    const { view } = renderSettings();

    const dialog = await openFinalDeletion(view, 'Squad');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir workspace' }));

    expect(view.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not delete when the workspace changes while the final dialog is open', async () => {
    const onDeleteWorkspace = vi.fn().mockResolvedValue(undefined);
    const { client, view } = renderSettings({ onDeleteWorkspace });
    await openFinalDeletion(view, 'Squad');

    const renamed = { ...adminMembership, workspace: { ...workspace, name: 'Squad Renomeado' } };
    view.rerender(
      <SettingsView
        apiClient={client}
        activeMembership={renamed}
        currentUserId="u-admin"
        onDeleteWorkspace={onDeleteWorkspace}
      />,
    );
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir workspace' }),
    );
    expect(onDeleteWorkspace).not.toHaveBeenCalled();

    await openFinalDeletion(view, 'Squad Renomeado');
    view.rerender(
      <SettingsView
        apiClient={client}
        currentUserId="u-admin"
        onDeleteWorkspace={onDeleteWorkspace}
      />,
    );
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir workspace' }),
    );
    expect(onDeleteWorkspace).not.toHaveBeenCalled();
  });
});

describe('WorkspaceMembersModal final deletion dialog', () => {
  const owner: WorkspaceMember = {
    ...member('owner', { id: 'u-owner', name: 'Owner', email: 'owner@corp.com' }),
    userId: 'u-owner',
    role: 'ADMIN',
  };

  function renderModal(workspaceName: string, onDeleteWorkspace = vi.fn()) {
    const client = new ApiClient();
    vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([owner]);
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      workspaceId: 'ws',
      currentUserId: 'u-owner',
      apiClient: client,
      onDeleteWorkspace,
    };
    const view = render(<WorkspaceMembersModal {...props} workspaceName={workspaceName} />);
    return { view, props, onDeleteWorkspace };
  }

  async function openFinalDeletion(view: ReturnType<typeof render>, name: string) {
    fireEvent.click(await view.findByRole('button', { name: 'Excluir workspace' }));
    fireEvent.change(
      view.getByRole('textbox', { name: 'Nome completo do workspace para confirmação' }),
      {
        target: { value: name },
      },
    );
    fireEvent.click(view.getByRole('button', { name: 'Confirmar exclusão' }));
    return view.findByRole('alertdialog', { name: 'Excluir workspace permanentemente?' });
  }

  it('closes on cancel without deleting', async () => {
    const { view, onDeleteWorkspace } = renderModal('Squad');

    const dialog = await openFinalDeletion(view, 'Squad');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    expect(view.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('does not delete when the workspace is renamed while confirming', async () => {
    const { view, props, onDeleteWorkspace } = renderModal('Squad');

    await openFinalDeletion(view, 'Squad');
    view.rerender(<WorkspaceMembersModal {...props} workspaceName="Squad Renomeado" />);
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', { name: 'Excluir workspace' }),
    );

    expect(onDeleteWorkspace).not.toHaveBeenCalled();
    expect(view.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
