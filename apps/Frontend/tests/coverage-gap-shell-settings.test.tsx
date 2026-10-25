import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const bia: WorkspaceMember = {
  id: 'm-bia',
  workspaceId: 'ws',
  userId: 'u-bia',
  role: 'MEMBER',
  permissions: {},
  createdAt: '',
  user: { id: 'u-bia', name: 'Bia', email: 'bia@corp.com' },
};

function renderSettings(members: WorkspaceMember[] = []) {
  const client = new ApiClient();
  vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue(members);
  vi.spyOn(client, 'getPermissionGroups').mockResolvedValue([]);
  vi.spyOn(client, 'listAccessTokens').mockResolvedValue([]);
  const view = render(
    <SettingsView apiClient={client} activeMembership={adminMembership} currentUserId="u-admin" />,
  );
  return { client, view };
}

afterEach(() => vi.restoreAllMocks());

describe('AccessTokensPanel load failure', () => {
  it('shows the server message when tokens cannot be loaded', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'listAccessTokens').mockRejectedValue(new Error('Sessão expirada'));
    render(<AccessTokensPanel apiClient={client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sessão expirada');
  });
});

describe('SettingsView members', () => {
  it('invites a member as administrator', async () => {
    const { client, view } = renderSettings();
    const add = vi.spyOn(client, 'addWorkspaceMember').mockResolvedValue({ ...bia, role: 'ADMIN' });
    fireEvent.click(view.getByTestId('settings-section-members'));

    fireEvent.change(await view.findByPlaceholderText('email@exemplo.com'), {
      target: { value: 'bia@corp.com' },
    });
    fireEvent.change(view.getByRole('combobox', { name: 'Função' }), {
      target: { value: 'ADMIN' },
    });
    fireEvent.click(view.getByRole('button', { name: /adicionar/i }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('ws', { email: 'bia@corp.com', role: 'ADMIN' }),
    );
  });

  it('shows the server message when member permissions cannot be saved', async () => {
    const { client, view } = renderSettings([bia]);
    vi.spyOn(client, 'updateWorkspaceMember').mockRejectedValue(new Error('Sem permissão'));
    fireEvent.click(view.getByTestId('settings-section-members'));

    const row = await view.findByTestId('member-row-m-bia');
    fireEvent.click(within(row).getByRole('button', { name: 'Permissões Bia' }));
    fireEvent.click(
      within(view.getByTestId('member-access-m-bia')).getByRole('button', { name: 'Salvar' }),
    );

    expect(await view.findByText('Sem permissão')).toBeInTheDocument();
  });
});
