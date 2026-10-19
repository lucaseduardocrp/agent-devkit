import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { SkeletonListItem } from '../../components/ui/skeleton.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import type { ApiClient } from '../../lib/api-client.js';
import type { WorkspaceMember, WorkspaceRole } from './workspace-types.js';
import { useI18n } from '../../lib/i18n/index.js';

export interface WorkspaceMembersModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly currentUserId: string;
  readonly apiClient: ApiClient;
  readonly onDeleteWorkspace: (workspaceId: string) => Promise<void>;
  readonly className?: string;
}

export function WorkspaceMembersModal({
  isOpen,
  onClose,
  workspaceId,
  workspaceName,
  currentUserId,
  apiClient,
  onDeleteWorkspace,
  className,
}: WorkspaceMembersModalProps) {
  const { t } = useI18n();
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('MEMBER');
  const [isSubmittingInvite, setIsSubmittingInvite] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteConfirmationName, setDeleteConfirmationName] = useState('');
  const [isFinalDeleteConfirmationOpen, setIsFinalDeleteConfirmationOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getWorkspaceMembers(workspaceId);
      setMembers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.loadMembersFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, workspaceId, t]);

  useEffect(() => {
    if (isOpen && workspaceId) {
      void loadMembers();
      setInviteEmail('');
      setInviteRole('MEMBER');
      setActionError(null);
      setIsConfirmingDelete(false);
      setDeleteConfirmationName('');
      setIsFinalDeleteConfirmationOpen(false);
      setIsDeleting(false);
      setDeleteError(null);
    }
  }, [isOpen, workspaceId, loadMembers]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleInviteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) {
      setActionError(t('settings.emailRequired'));
      return;
    }
    setActionError(null);
    setIsSubmittingInvite(true);
    try {
      await apiClient.addWorkspaceMember(workspaceId, {
        email,
        role: inviteRole,
      });
      setInviteEmail('');
      await loadMembers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('settings.inviteFailed'));
    } finally {
      setIsSubmittingInvite(false);
    }
  };

  const handleRoleChange = async (memberId: string, newRole: WorkspaceRole) => {
    setActionError(null);
    try {
      await apiClient.updateWorkspaceMember(workspaceId, memberId, { role: newRole });
      await loadMembers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('settings.roleUpdateFailed'));
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    setActionError(null);
    try {
      await apiClient.removeWorkspaceMember(workspaceId, memberId);
      await loadMembers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('settings.removeMemberFailed'));
    }
  };

  const currentMember = members.find((m) => m.userId === currentUserId);
  const isAdmin = currentMember?.role === 'ADMIN';

  const handleDeleteWorkspace = async () => {
    if (deleteConfirmationName.trim() !== workspaceName) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteWorkspace(workspaceId);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('settings.deleteWorkspaceFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-members-title"
      data-testid="workspace-members-modal"
    >
      <div
        className={cn(
          'relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface-1 shadow-2xl',
          className,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2
              id="workspace-members-title"
              className="text-base font-bold text-[var(--text-primary)]"
            >
              {t('workspaces.members')}
            </h2>
            <p className="text-xs text-muted">{workspaceName}</p>
          </div>
          <IconButton
            icon={<i className="ti ti-x text-lg" aria-hidden="true" />}
            label={t('runtime.closeModal')}
            onClick={onClose}
            size="sm"
          />
        </div>

        {/* Content Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {actionError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
              {actionError}
            </div>
          )}

          {/* Add member form */}
          <form
            onSubmit={(e) => {
              void handleInviteSubmit(e);
            }}
            className="rounded-lg border border-border bg-surface-2 p-3"
          >
            <span className="mb-2 block text-xs font-semibold text-[var(--text-primary)]">
              {t('workspaces.addMember')}
            </span>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t('workspaces.emailPlaceholder')}
                  disabled={isSubmittingInvite}
                  aria-label={t('auth.email')}
                />
              </div>
              <div className="w-full sm:w-40">
                <Select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
                  disabled={isSubmittingInvite}
                  aria-label={t('common.role')}
                >
                  <option value="ADMIN">{t('workspaces.roleAdmin')}</option>
                  <option value="INTEGRATOR">{t('workspaces.roleIntegrator')}</option>
                  <option value="MEMBER">{t('workspaces.roleMember')}</option>
                  <option value="VIEWER">{t('workspaces.roleViewer')}</option>
                </Select>
              </div>
              <Button
                type="submit"
                disabled={isSubmittingInvite}
                isLoading={isSubmittingInvite}
                className="h-[40px] px-4"
                leftIcon={<i className="ti ti-user-plus" aria-hidden="true" />}
              >
                {t('workspaces.addMember')}
              </Button>
            </div>
          </form>

          {/* Member list */}
          <div>
            <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
              {t('workspaces.members')} ({members.length})
            </span>

            {isLoading ? (
              <div className="space-y-2 py-2" data-testid="modal-members-loading-skeleton">
                <SkeletonListItem />
                <SkeletonListItem />
              </div>
            ) : error ? (
              <div className="py-4 text-center text-xs text-red-400">{error}</div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border bg-surface-2">
                {members.map((m) => {
                  const isMe = m.userId === currentUserId;
                  const displayName = m.user?.name || m.user?.email || t('workspaces.roleMember');
                  const displayEmail = m.user?.email || '';

                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-3 p-3 text-xs"
                      data-testid={`member-row-${m.id}`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--fill-accent)] text-[11px] font-bold text-surface-0">
                          {displayName.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-[var(--text-primary)]">
                              {displayName}
                            </span>
                            {isMe && (
                              <span className="rounded bg-surface-3 px-1 py-0.2 text-[9px] font-semibold text-muted">
                                {t('settings.you')}
                              </span>
                            )}
                          </div>
                          {displayEmail && displayName !== displayEmail && (
                            <span className="block truncate text-[11px] text-muted">
                              {displayEmail}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="w-32">
                          <Select
                            selectSize="sm"
                            value={m.role}
                            onChange={(e) => {
                              void handleRoleChange(m.id, e.target.value as WorkspaceRole);
                            }}
                            aria-label={`${t('common.role')} ${displayName}`}
                          >
                            <option value="ADMIN">{t('workspaces.roleAdmin')}</option>
                            <option value="INTEGRATOR">{t('workspaces.roleIntegrator')}</option>
                            <option value="MEMBER">{t('workspaces.roleMember')}</option>
                            <option value="VIEWER">{t('workspaces.roleViewer')}</option>
                          </Select>
                        </div>

                        <IconButton
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void handleRemoveMember(m.id);
                          }}
                          className="text-muted hover:bg-red-500/10 hover:text-red-400"
                          title={t('workspaces.removeMember')}
                          label={`${t('workspaces.removeMember')} ${displayName}`}
                          icon={<i className="ti ti-trash text-sm" aria-hidden="true" />}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {isAdmin && (
            <div className="mt-6 border-t border-border pt-4">
              <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-red-400">
                      {t('settings.dangerZone')}
                    </h4>
                    <p className="text-[11px] text-muted">
                      {t('settings.deleteWorkspaceDescription', { name: workspaceName })}
                    </p>
                  </div>

                  {!isConfirmingDelete ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setIsConfirmingDelete(true)}
                      aria-label={t('workspaces.deleteWorkspace')}
                    >
                      {t('workspaces.deleteWorkspace')}
                    </Button>
                  ) : (
                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[280px]">
                      <p className="text-[11px] text-red-300">
                        {t('settings.typeWorkspaceName', { name: workspaceName })}
                      </p>
                      <Input
                        value={deleteConfirmationName}
                        onChange={(event) => setDeleteConfirmationName(event.target.value)}
                        placeholder={workspaceName}
                        disabled={isDeleting}
                        aria-label={t('settings.workspaceNameConfirmation')}
                      />
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={isDeleting || deleteConfirmationName.trim() !== workspaceName}
                          isLoading={isDeleting}
                          onClick={() => setIsFinalDeleteConfirmationOpen(true)}
                          aria-label={t('settings.confirmWorkspaceDeletion')}
                        >
                          {t('settings.confirmWorkspaceDeletion')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isDeleting}
                          onClick={() => {
                            setIsConfirmingDelete(false);
                            setDeleteConfirmationName('');
                            setDeleteError(null);
                          }}
                          aria-label={t('settings.cancelDeletion')}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {deleteError && <div className="mt-2 text-[11px] text-red-400">{deleteError}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmationDialog
        open={isFinalDeleteConfirmationOpen}
        title={t('settings.deleteWorkspacePermanently')}
        description={t('settings.deleteWorkspaceDescription', { name: workspaceName })}
        confirmLabel={t('workspaces.deleteWorkspace')}
        cancelLabel={t('common.cancel')}
        destructive
        isLoading={isDeleting}
        onCancel={() => setIsFinalDeleteConfirmationOpen(false)}
        onConfirm={() => {
          setIsFinalDeleteConfirmationOpen(false);
          void handleDeleteWorkspace();
        }}
      />
    </div>
  );
}
