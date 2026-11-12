import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccessTokensPanel } from '../src/features/settings/AccessTokensPanel.js';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';
import type {
  UserWorkspaceMembership,
  WorkspaceMember,
} from '../src/features/workspaces/workspace-types.js';
import { ApiClient } from '../src/lib/api-client.js';

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

const bob: WorkspaceMember = {
  id: 'm-bob',
  workspaceId: 'ws',
  userId: 'u-bob',
  role: 'MEMBER',
  permissions: {},
  createdAt: '',
  user: { id: 'u-bob', name: 'Bob', email: 'bob@corp.com' },
};

function setup(
  props: Partial<Parameters<typeof SettingsView>[0]> = {},
  members: WorkspaceMember[] = [],
) {
  const client = new ApiClient();
  vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue(members);
  vi.spyOn(client, 'getPermissionGroups').mockResolvedValue([]);
  vi.spyOn(client, 'listAccessTokens').mockResolvedValue([]);
  vi.spyOn(client, 'getWorkItemTypes').mockResolvedValue([]);
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

describe('AccessTokensPanel load failures', () => {
  it('shows the message of the error when tokens cannot be loaded', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockRejectedValue(new Error('Sessão expirada'));
    const view = render(<AccessTokensPanel apiClient={client} />);
    expect((await view.findByRole('alert')).textContent).toContain('Sessão expirada');
  });
});

describe('SettingsView extra flows', () => {
  it('shows the work item types section to administrators and read-only to others', async () => {
    const { view } = setup();
    fireEvent.click(view.getByTestId('settings-section-types'));
    expect(await view.findByTestId('work-item-types-panel')).toBeTruthy();
    expect(view.getByRole('button', { name: /Salvar tipos/ })).toBeTruthy();
    view.unmount();

    const member: UserWorkspaceMembership = {
      ...adminMembership,
      member: { ...adminMembership.member, role: 'MEMBER' },
      access: {
        ...FULL_ACCESS,
        workspace: { ...FULL_ACCESS.workspace, editWorkspace: false },
      },
    };
    const readOnly = setup({ activeMembership: member });
    fireEvent.click(readOnly.view.getByTestId('settings-section-types'));
    expect(await readOnly.view.findByTestId('work-item-types-panel')).toBeTruthy();
    expect(readOnly.view.queryByRole('button', { name: /Salvar tipos/ })).toBeNull();
  });

  it('does not offer the types section without an API client', () => {
    const view = render(<SettingsView activeMembership={adminMembership} />);
    fireEvent.click(view.getByTestId('settings-section-types'));
    expect(view.queryByTestId('work-item-types-panel')).toBeNull();
  });

  it('keeps the chosen invite role when inviting', async () => {
    const { client, view } = setup();
    const add = vi.spyOn(client, 'addWorkspaceMember').mockResolvedValue(bob);
    fireEvent.click(view.getByTestId('settings-section-members'));
    await waitFor(() => expect(client.getWorkspaceMembers).toHaveBeenCalled());
    fireEvent.change(view.getByLabelText('Função'), { target: { value: 'ADMIN' } });
    fireEvent.change(view.getByLabelText('E-mail'), { target: { value: 'new@corp.com' } });
    fireEvent.submit(view.getByLabelText('E-mail').closest('form')!);
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('ws', { email: 'new@corp.com', role: 'ADMIN' }),
    );
  });

  it('shows the server message when saving member permissions fails', async () => {
    const { client, view } = setup({}, [bob]);
    vi.spyOn(client, 'updateWorkspaceMember').mockRejectedValue(new Error('Sem permissão'));
    fireEvent.click(view.getByTestId('settings-section-members'));
    const row = await view.findByTestId('member-row-m-bob');
    fireEvent.click(within(row).getByRole('button', { name: 'Permissões Bob' }));
    fireEvent.click(
      within(view.getByTestId('member-access-m-bob')).getByRole('button', { name: 'Salvar' }),
    );
    expect(await view.findByText('Sem permissão')).toBeTruthy();
  });
});
