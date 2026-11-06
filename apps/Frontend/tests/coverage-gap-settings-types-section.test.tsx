import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { FULL_ACCESS } from '../src/features/workspaces/permissions.js';
import type { UserWorkspaceMembership } from '../src/features/workspaces/workspace-types.js';
import { ApiClient } from '../src/lib/api-client.js';

afterEach(() => vi.restoreAllMocks());

const workspace = { id: 'ws', name: 'Squad', slug: 'squad', ownerId: 'u-admin', createdAt: '' };
const membership = (role: 'ADMIN' | 'VIEWER'): UserWorkspaceMembership => ({
  workspace,
  member: { id: 'm', workspaceId: 'ws', userId: 'u', role, permissions: {}, createdAt: '' },
  ...(role === 'ADMIN' ? { access: FULL_ACCESS } : {}),
});

async function open(role: 'ADMIN' | 'VIEWER') {
  const client = new ApiClient();
  vi.spyOn(client, 'getWorkspaceMembers').mockResolvedValue([]);
  vi.spyOn(client, 'getPermissionGroups').mockResolvedValue([]);
  vi.spyOn(client, 'getWorkItemTypes').mockResolvedValue([
    { key: 'bug', label: 'Bug', color: 'red', icon: 'bug', aliases: [] },
  ]);
  render(<SettingsView apiClient={client} activeMembership={membership(role)} currentUserId="u" />);
  fireEvent.click(screen.getByTestId('settings-section-types'));
  await screen.findByTestId('work-item-types-panel');
}

describe('SettingsView work item types section', () => {
  it('lets administrators edit the types', async () => {
    await open('ADMIN');
    expect(screen.getByText('Adicionar tipo')).toBeTruthy();
  });

  it('keeps the types read-only without permission to edit the workspace', async () => {
    await open('VIEWER');
    expect(screen.queryByText('Adicionar tipo')).toBeNull();
  });
});
