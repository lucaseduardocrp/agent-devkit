import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { HistoryViewer } from '../src/features/audit/HistoryViewer.js';
import {
  accessFor,
  allows,
  FULL_ACCESS,
  PermissionsProvider,
  toggleOperation,
  usePermissions,
} from '../src/features/workspaces/permissions.js';
import type { UserWorkspaceMembership } from '../src/features/workspaces/workspace-types.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

const membership = (
  role: UserWorkspaceMembership['member']['role'],
  permissions: UserWorkspaceMembership['member']['permissions'] = {},
): UserWorkspaceMembership => ({
  workspace: { id: 'ws', name: 'WS', slug: 'ws', ownerId: 'u', createdAt: '' },
  member: { id: 'm', workspaceId: 'ws', userId: 'u', role, permissions, createdAt: '' },
});

describe('permissions helpers', () => {
  it('treats module access levels as cumulative', () => {
    expect(allows('delete', 'view')).toBe(true);
    expect(allows('view', 'edit')).toBe(false);
    expect(allows(undefined, 'view')).toBe(false);
  });

  it('toggles operations following the cumulative levels', () => {
    expect(toggleOperation(undefined, 'edit')).toBe('edit');
    expect(toggleOperation('view', 'delete')).toBe('delete');
    expect(toggleOperation('delete', 'edit')).toBe('view');
    expect(toggleOperation('view', 'view')).toBe('none');
  });

  it('resolves the access of a membership, falling back to the former role defaults', () => {
    expect(accessFor(undefined)).toBe(FULL_ACCESS);
    const access = { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, pbis: 'view' as const } };
    expect(accessFor({ ...membership('MEMBER'), access })).toBe(access);
    expect(accessFor(membership('ADMIN'))).toBe(FULL_ACCESS);

    const viewer = accessFor(membership('VIEWER'));
    expect(viewer.modules).toMatchObject({ pbis: 'view', integrations: 'none' });
    expect(viewer.workspace.addMembers).toBe(false);

    const member = accessFor(membership('MEMBER', { canManageMembers: true, manageCosts: true }));
    expect(member.modules).toMatchObject({ pbis: 'delete', integrations: 'view' });
    expect(member.workspace).toMatchObject({
      addMembers: true,
      removeMembers: true,
      manageRoles: true,
      manageGroups: false,
      manageCosts: true,
    });
    expect(
      accessFor(membership('MEMBER', { canManageIntegrations: true })).modules.integrations,
    ).toBe('delete');
    expect(accessFor(membership('INTEGRATOR')).modules.integrations).toBe('delete');
    expect(
      accessFor(membership('MEMBER', { addMembers: true, removeMembers: true, manageRoles: true }))
        .workspace,
    ).toMatchObject({ addMembers: true, removeMembers: true, manageRoles: true });
  });

  it('exposes the provided access through usePermissions', () => {
    const access = {
      modules: { ...FULL_ACCESS.modules, brain: 'view' as const },
      workspace: { ...FULL_ACCESS.workspace, manageGroups: false },
    };
    const { result } = renderHook(() => usePermissions(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PermissionsProvider access={access}>{children}</PermissionsProvider>
      ),
    });
    expect(result.current.can('brain')).toBe(true);
    expect(result.current.can('brain', 'edit')).toBe(false);
    expect(result.current.canWorkspace('manageGroups')).toBe(false);
    expect(renderHook(() => usePermissions()).result.current.access).toBe(FULL_ACCESS);
  });
});

describe('History viewer inside other components', () => {
  it('does not submit an enclosing form nor leak its events to the parent', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuditHistory').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      totalPages: 0,
    });
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onParentClick = vi.fn();
    const onParentKeyDown = vi.fn();
    const view = render(
      <I18nProvider initialLocale="pt-BR">
        <form onSubmit={onSubmit}>
          <div onClick={onParentClick} onKeyDown={onParentKeyDown}>
            <HistoryViewer
              apiClient={client}
              entityType="testcase"
              workspaceId="ws"
              entityId="plan:case"
              size="sm"
            />
          </div>
        </form>
      </I18nProvider>,
    );

    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await view.findByText('Nenhuma alteração registrada.')).toBeInTheDocument();
    expect(view.getByText('Histórico · Caso de teste')).toBeInTheDocument();
    expect(client.getAuditHistory).toHaveBeenCalledWith(
      'testcase',
      1,
      expect.any(AbortSignal),
      'plan:case',
    );
    onParentClick.mockClear();

    const dialog = view.getByRole('dialog', { hidden: true });
    fireEvent.click(dialog);
    fireEvent.mouseDown(dialog);
    fireEvent.pointerDown(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.submit(dialog);
    expect(onParentClick).not.toHaveBeenCalled();
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Fechar', hidden: true }));
    });
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
  });
});
