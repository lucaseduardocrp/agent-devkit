import { useState } from 'react';
import type { UserWorkspaceMembership, WorkspaceRole } from './workspace-types.js';
import { cn } from '../../lib/utils.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useI18n, type TranslationKey } from '../../lib/i18n/index.js';

export interface WorkspaceSwitcherProps {
  readonly workspaces: readonly UserWorkspaceMembership[];
  readonly activeWorkspaceId: string | null;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onCreateWorkspace: (name: string) => Promise<void>;
  readonly onOpenMembersModal?: () => void;
  readonly isLoading?: boolean;
}

const roleKeys: Record<WorkspaceRole, TranslationKey> = {
  ADMIN: 'workspaces.roleAdmin',
  INTEGRATOR: 'workspaces.roleIntegrator',
  MEMBER: 'workspaces.roleMember',
  VIEWER: 'workspaces.roleViewer',
};

function getRoleBadgeClass(role: WorkspaceRole): string {
  switch (role) {
    case 'ADMIN':
      return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
    case 'INTEGRATOR':
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    case 'VIEWER':
      return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    case 'MEMBER':
    default:
      return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  }
}

export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenMembersModal,
  isLoading = false,
}: WorkspaceSwitcherProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const activeMembership = workspaces.find((w) => w.workspace.id === activeWorkspaceId);
  const canManageMembers =
    activeMembership?.member.role === 'ADMIN' ||
    activeMembership?.member.permissions.canManageMembers;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newWorkspaceName.trim();
    if (!trimmed) {
      setCreateError(t('workspaces.requiredName'));
      return;
    }
    setCreateError(null);
    try {
      await onCreateWorkspace(trimmed);
      setNewWorkspaceName('');
      setIsCreating(false);
      setIsOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t('workspaces.createError'));
    }
  };

  if (isLoading) {
    return (
      <div
        className="border-b border-border px-3 py-2 text-xs"
        data-testid="workspace-switcher-skeleton"
      >
        <Skeleton className="h-8 w-full rounded" />
      </div>
    );
  }

  return (
    <div className="relative border-b border-border px-3 py-2 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--fill-ghost-hover)]"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-label={t('workspaces.select')}
        disabled={isLoading}
      >
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-[var(--text-primary)]">
            {activeMembership ? activeMembership.workspace.name : t('workspaces.selectPlaceholder')}
          </span>
          {activeMembership && (
            <span
              className={cn(
                'mt-0.5 inline-block w-fit rounded border px-1.5 py-0.2 text-[10px] font-medium leading-normal',
                getRoleBadgeClass(activeMembership.member.role),
              )}
            >
              {t(roleKeys[activeMembership.member.role])}
            </span>
          )}
        </div>
        <i
          className={cn(
            'ti ti-chevron-down text-sm text-[var(--text-secondary)] transition-transform',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div className="absolute left-3 right-3 top-full z-50 mt-1 rounded-md border border-border bg-surface-2 p-1.5 shadow-xl">
          <div className="mb-1 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
            {t('workspaces.list')}
          </div>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {workspaces.map((m) => {
              const isSelected = m.workspace.id === activeWorkspaceId;
              return (
                <button
                  key={m.workspace.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--fill-ghost-hover)]',
                    isSelected && 'bg-[var(--fill-ghost-selected)] font-medium',
                  )}
                  onClick={() => {
                    onSelectWorkspace(m.workspace.id);
                    setIsOpen(false);
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[var(--text-primary)]">{m.workspace.name}</span>
                    <span className="text-[10px] text-muted">{t(roleKeys[m.member.role])}</span>
                  </div>
                  {isSelected && (
                    <i className="ti ti-check text-xs text-accent-foreground" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="my-1 border-t border-border" />

          {isCreating ? (
            <form
              onSubmit={(e) => {
                void handleCreateSubmit(e);
              }}
              className="space-y-2 p-1"
            >
              <Input
                type="text"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder={t('workspaces.namePlaceholder')}
                autoFocus
              />
              {createError && <div className="text-[10px] text-red-400">{createError}</div>}
              <div className="flex gap-1.5">
                <Button type="submit" size="sm" className="flex-1">
                  {t('workspaces.create')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsCreating(false);
                    setCreateError(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]"
            >
              <i className="ti ti-plus text-xs" aria-hidden="true" />
              <span>{t('workspaces.newWorkspaceAction')}</span>
            </button>
          )}

          {canManageMembers && onOpenMembersModal && (
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenMembersModal();
              }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-primary)]"
            >
              <i className="ti ti-users text-xs" aria-hidden="true" />
              <span>{t('workspaces.manageMembersAction')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
