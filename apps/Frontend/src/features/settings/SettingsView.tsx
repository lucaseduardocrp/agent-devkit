import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import { SkeletonListItem } from '../../components/ui/skeleton.js';
import { ResizableSidebar } from '../../components/layout/ResizableSidebar.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import type { ApiClient } from '../../lib/api-client.js';
import { AccessTokensPanel } from './AccessTokensPanel.js';
import { PermissionGroupsPanel } from './PermissionGroupsPanel.js';
import { accessFor } from '../workspaces/permissions.js';
import { useI18n, type SupportedLocale, type TranslationKey } from '../../lib/i18n/index.js';
import {
  type PermissionGroup,
  type UserWorkspaceMembership,
  type Workspace,
  type WorkspaceMember,
  type WorkspacePermissionKey,
  type WorkspacePermissions,
  type WorkspaceRole,
  WORKSPACE_PERMISSION_KEYS,
  getRoleBadgeClass,
} from '../workspaces/workspace-types.js';

type SettingsSection = 'general' | 'members' | 'groups' | 'workspace' | 'tokens';

const sectionIcons: Record<SettingsSection, string> = {
  general: 'ti-settings',
  members: 'ti-users',
  groups: 'ti-shield-lock',
  workspace: 'ti-building-community',
  tokens: 'ti-key',
};

const sectionLabels: Record<SettingsSection, TranslationKey> = {
  general: 'settings.general',
  members: 'settings.members',
  groups: 'permissions.section',
  workspace: 'settings.workspace',
  tokens: 'settings.accessTokens',
};

const roleKeys: Record<WorkspaceRole, TranslationKey> = {
  ADMIN: 'workspaces.roleAdmin',
  MEMBER: 'workspaces.roleMember',
  VIEWER: 'workspaces.roleViewer',
  INTEGRATOR: 'workspaces.roleIntegrator',
};

export interface SettingsViewProps {
  readonly apiClient?: ApiClient;
  readonly className?: string;
  readonly activeMembership?: UserWorkspaceMembership;
  readonly currentUserId?: string;
  readonly onDeleteWorkspace?: (workspaceId: string) => Promise<void>;
  readonly onWorkspaceRenamed?: (workspace: Workspace) => void;
}

export function SettingsView({
  apiClient,
  className,
  activeMembership,
  currentUserId,
  onDeleteWorkspace,
  onWorkspaceRenamed,
}: SettingsViewProps) {
  const { locale, setLocale, t, formatDate } = useI18n();
  const getRoleLabel = (role: WorkspaceRole) => t(roleKeys[role]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');

  // Members state for active workspace
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('MEMBER');
  const [inviteGroupIds, setInviteGroupIds] = useState<readonly string[]>([]);
  const [isSubmittingInvite, setIsSubmittingInvite] = useState(false);
  const [groups, setGroups] = useState<readonly PermissionGroup[]>([]);
  // Member whose workspace permissions and groups are being edited.
  const [accessDraft, setAccessDraft] = useState<{
    memberId: string;
    permissions: WorkspacePermissions;
    groupIds: readonly string[];
  } | null>(null);
  const [workspaceName, setWorkspaceName] = useState(activeMembership?.workspace.name ?? '');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameMessage, setRenameMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Delete workspace state
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteConfirmationName, setDeleteConfirmationName] = useState('');
  const [isFinalDeleteConfirmationOpen, setIsFinalDeleteConfirmationOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const activeWorkspaceId = activeMembership?.workspace.id;
  const isAdmin = activeMembership?.member.role === 'ADMIN';
  const workspaceAccess = accessFor(activeMembership).workspace;
  const canAddMembers = workspaceAccess.addMembers;
  const canRemoveMembers = workspaceAccess.removeMembers;
  const canManageRoles = workspaceAccess.manageRoles;
  const canManageGroups = workspaceAccess.manageGroups;
  const canEditWorkspace = workspaceAccess.editWorkspace;
  const canDeleteWorkspace = workspaceAccess.deleteWorkspace;
  const sections: readonly SettingsSection[] = canManageGroups
    ? ['general', 'members', 'groups', 'workspace', 'tokens']
    : ['general', 'members', 'workspace', 'tokens'];
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name;
  const loadMembers = useCallback(async () => {
    if (!apiClient || !activeWorkspaceId) return;
    setIsLoadingMembers(true);
    setMembersError(null);
    try {
      const data = await apiClient.getWorkspaceMembers(activeWorkspaceId);
      setMembers(data);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : t('settings.loadMembersFailed'));
    } finally {
      setIsLoadingMembers(false);
    }
  }, [apiClient, activeWorkspaceId, t]);

  // Groups only label members and feed the editors, so a failure hides them quietly.
  const loadGroups = useCallback(async () => {
    if (!apiClient || !activeWorkspaceId) return;
    try {
      setGroups(await apiClient.getPermissionGroups(activeWorkspaceId));
    } catch {
      setGroups([]);
    }
  }, [apiClient, activeWorkspaceId]);

  const reloadAccess = useCallback(
    () => Promise.all([loadMembers(), loadGroups()]).then(() => undefined),
    [loadGroups, loadMembers],
  );

  useEffect(() => {
    if (activeWorkspaceId) {
      void loadMembers();
      void loadGroups();
      setInviteEmail('');
      setInviteRole('MEMBER');
      setInviteGroupIds([]);
      setAccessDraft(null);
      setActionError(null);
      setActionSuccess(null);
      setIsConfirmingDelete(false);
      setDeleteConfirmationName('');
      setIsFinalDeleteConfirmationOpen(false);
      setIsDeleting(false);
      setDeleteError(null);
    } else {
      setMembers([]);
    }
  }, [activeWorkspaceId, loadGroups, loadMembers]);

  const activeWorkspaceName = activeMembership?.workspace.name ?? '';
  useEffect(() => {
    setWorkspaceName(activeWorkspaceName);
    setRenameMessage(null);
  }, [activeWorkspaceName]);

  const handleInviteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiClient) return;
    const email = inviteEmail.trim();
    if (!email) {
      setActionError(t('settings.emailRequired'));
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    setIsSubmittingInvite(true);
    try {
      await apiClient.addWorkspaceMember(activeMembership!.workspace.id, {
        email,
        role: inviteRole,
        ...(inviteGroupIds.length ? { groupIds: inviteGroupIds } : {}),
      });
      setInviteEmail('');
      setInviteGroupIds([]);
      setActionSuccess(t('settings.inviteSuccess'));
      await loadMembers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('settings.inviteFailed'));
    } finally {
      setIsSubmittingInvite(false);
    }
  };

  const handleRoleChange = async (memberId: string, newRole: WorkspaceRole) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiClient!.updateWorkspaceMember(activeMembership!.workspace.id, memberId, {
        role: newRole,
      });
      setActionSuccess(t('settings.memberRoleUpdated'));
      await loadMembers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('settings.roleUpdateFailed'));
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiClient!.removeWorkspaceMember(activeMembership!.workspace.id, memberId);
      setActionSuccess(t('settings.memberRemoved'));
      await loadMembers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('settings.removeMemberFailed'));
    }
  };

  const handleSaveAccess = async (draft: NonNullable<typeof accessDraft>) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiClient!.updateWorkspaceMember(activeMembership!.workspace.id, draft.memberId, {
        ...(canManageRoles ? { permissions: draft.permissions } : {}),
        ...(canManageGroups ? { groupIds: draft.groupIds } : {}),
      });
      setAccessDraft(null);
      setActionSuccess(t('permissions.permissionsSaved'));
      await reloadAccess();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('permissions.saveFailed'));
    }
  };

  const handleRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!apiClient || !activeMembership) return;
    setIsRenaming(true);
    setRenameMessage(null);
    try {
      const workspace = await apiClient.renameWorkspace(
        activeMembership.workspace.id,
        workspaceName.trim(),
      );
      onWorkspaceRenamed?.(workspace);
      setRenameMessage({ ok: true, text: t('permissions.workspaceRenamed') });
    } catch (err) {
      setRenameMessage({
        ok: false,
        text: err instanceof Error ? err.message : t('permissions.saveFailed'),
      });
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!onDeleteWorkspace) return;
    if (deleteConfirmationName.trim() !== activeMembership?.workspace.name) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteWorkspace(activeMembership.workspace.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('settings.deleteWorkspaceFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      className={cn(
        'flex h-full min-h-[calc(100vh-96px)] w-full max-w-none overflow-hidden bg-[#181818] lg:flex-row',
        className,
      )}
      data-testid="screen-settings"
    >
      <ResizableSidebar
        defaultWidth={260}
        minWidth={220}
        maxWidth="container"
        resizeLabel={t('settings.resizeNavigation')}
        aria-label={t('settings.resizeNavigation')}
        data-testid="settings-sidebar"
        className="h-full border-r border-[#262626] bg-[#1a1a1a] text-sm select-none"
      >
        <nav className="flex h-full w-full flex-col gap-1 p-2" aria-label={t('settings.sections')}>
          {sections.map((section) => (
            <Button
              key={section}
              type="button"
              variant={settingsSection === section ? 'secondary' : 'ghost'}
              size="sm"
              className="justify-start gap-2"
              aria-current={settingsSection === section ? 'page' : undefined}
              onClick={() => setSettingsSection(section)}
              data-testid={`settings-section-${section}`}
              leftIcon={<i className={`ti ${sectionIcons[section]}`} aria-hidden="true" />}
            >
              {t(sectionLabels[section])}
            </Button>
          ))}
        </nav>
      </ResizableSidebar>
      <div className="thin-scrollbar min-w-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="max-w-3xl space-y-6">
          {/* Preferências Regionais */}
          <div
            className={cn(
              'space-y-4 rounded-xl border border-border bg-surface-1 p-5 shadow-sm',
              settingsSection !== 'general' && 'hidden',
            )}
            data-testid="regional-preferences-card"
          >
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                {t('settings.regionalPreferences')}
              </h2>
              <p className="text-xs text-muted">{t('settings.regionalPreferencesDesc')}</p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="w-full sm:w-64">
                <label
                  htmlFor="locale-select"
                  className="mb-1.5 block text-xs text-[var(--text-secondary)]"
                >
                  {t('settings.languageSelect')}
                </label>
                <Select
                  id="locale-select"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as SupportedLocale)}
                  data-testid="settings-locale-select"
                >
                  <option value="pt-BR">{t('settings.portugueseBrazil')}</option>
                  <option value="en-US">{t('settings.englishUnitedStates')}</option>
                </Select>
              </div>

              <div className="mt-auto pb-1 text-xs text-[var(--text-secondary)]">
                <span className="text-muted">{t('settings.currentLocaleInfo')}</span>{' '}
                <span className="font-semibold text-accent-foreground">
                  {locale === 'pt-BR'
                    ? t('settings.portugueseLocaleName')
                    : t('settings.englishLocaleName')}
                </span>
              </div>
            </div>
          </div>

          {settingsSection === 'tokens' && (
            <div className="rounded-xl border border-border bg-surface-1 p-5 shadow-sm">
              <AccessTokensPanel apiClient={apiClient} />
            </div>
          )}

          {/* Detalhes do Workspace Ativo */}
          {activeMembership ? (
            <div
              className={cn(
                'space-y-4 rounded-xl border border-border bg-surface-1 p-5 shadow-sm',
                settingsSection !== 'workspace' && 'hidden',
              )}
              data-testid="active-workspace-card"
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {t('settings.workspaceSelected')}
                  </span>
                  <h2 className="text-lg font-bold text-[var(--text-primary)]">
                    {activeMembership.workspace.name}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded border px-2 py-0.5 text-xs font-semibold leading-normal',
                      getRoleBadgeClass(activeMembership.member.role),
                    )}
                  >
                    {t('common.role')}: {getRoleLabel(activeMembership.member.role)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-surface-2 p-3 text-xs sm:grid-cols-3">
                <div>
                  <span className="text-muted block text-[11px]">{t('settings.workspaceId')}</span>
                  <span className="font-mono text-[var(--text-secondary)]">
                    {activeMembership.workspace.id}
                  </span>
                </div>
                <div>
                  <span className="text-muted block text-[11px]">{t('settings.slug')}</span>
                  <span className="font-mono text-[var(--text-secondary)]">
                    {activeMembership.workspace.slug}
                  </span>
                </div>
                <div>
                  <span className="text-muted block text-[11px]">{t('settings.createdAt')}</span>
                  <span className="text-[var(--text-secondary)]">
                    {activeMembership.workspace.createdAt
                      ? formatDate(activeMembership.workspace.createdAt)
                      : 'N/A'}
                  </span>
                </div>
              </div>

              {canEditWorkspace && (
                <form
                  onSubmit={(event) => void handleRename(event)}
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                >
                  <label className="flex-1 space-y-1 text-xs text-[var(--text-secondary)]">
                    <span>{t('permissions.workspaceName')}</span>
                    <Input
                      required
                      maxLength={100}
                      value={workspaceName}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                    />
                  </label>
                  <Button
                    type="submit"
                    isLoading={isRenaming}
                    disabled={
                      !workspaceName.trim() ||
                      workspaceName.trim() === activeMembership.workspace.name
                    }
                  >
                    {t('permissions.renameWorkspace')}
                  </Button>
                </form>
              )}
              {renameMessage && (
                <p
                  role={renameMessage.ok ? 'status' : 'alert'}
                  className={cn('text-xs', renameMessage.ok ? 'text-emerald-400' : 'text-red-400')}
                >
                  {renameMessage.text}
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-surface-1 p-5 text-xs text-muted">
              {t('settings.noActiveWorkspace')}
            </div>
          )}

          {/* Gestão de Membros do Workspace Selecionado */}
          {activeMembership && (
            <div
              className={cn(
                'space-y-4 rounded-xl border border-border bg-surface-1 p-5 shadow-sm',
                settingsSection !== 'members' && 'hidden',
              )}
              data-testid="workspace-members-management"
            >
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t('settings.memberPermissions')}
                </h2>
                <p className="text-xs text-muted">
                  {t('settings.manageWorkspaceMembersDesc', {
                    name: activeMembership.workspace.name,
                  })}
                </p>
              </div>

              {actionError && (
                <div
                  className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400"
                  role="alert"
                >
                  <i className="ti ti-alert-circle text-base" aria-hidden="true" />
                  <span>{actionError}</span>
                </div>
              )}

              {actionSuccess && (
                <div
                  className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-400"
                  role="status"
                >
                  <i className="ti ti-circle-check text-base" aria-hidden="true" />
                  <span>{actionSuccess}</span>
                </div>
              )}

              {/* Form para adicionar membro (visível para quem pode gerenciar membros) */}
              {canAddMembers && (
                <form
                  onSubmit={(e) => {
                    void handleInviteSubmit(e);
                  }}
                  className="rounded-lg border border-border bg-surface-2 p-3 space-y-2"
                >
                  <span className="block text-xs font-semibold text-[var(--text-primary)]">
                    {t('settings.addMemberToWorkspace')}
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
                    <div className="w-full sm:w-44">
                      <Select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
                        disabled={isSubmittingInvite}
                        aria-label={t('common.role')}
                      >
                        {isAdmin && <option value="ADMIN">{t('workspaces.roleAdmin')}</option>}
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
                  {canManageGroups && groups.length > 0 && inviteRole !== 'ADMIN' && (
                    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
                      <legend className="sr-only">{t('permissions.memberGroups')}</legend>
                      <span className="text-[11px] font-semibold text-muted">
                        {t('permissions.memberGroups')}:
                      </span>
                      {groups.map((group) => (
                        <label
                          key={group.id}
                          className="flex cursor-pointer items-center gap-1.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
                            checked={inviteGroupIds.includes(group.id)}
                            disabled={isSubmittingInvite}
                            onChange={() =>
                              setInviteGroupIds((current) =>
                                current.includes(group.id)
                                  ? current.filter((id) => id !== group.id)
                                  : [...current, group.id],
                              )
                            }
                          />
                          {group.name}
                        </label>
                      ))}
                    </fieldset>
                  )}
                </form>
              )}

              {/* Lista de Membros */}
              <div className="space-y-2">
                <span className="block text-xs font-semibold uppercase tracking-wider text-muted">
                  {t('settings.membersOfWorkspace')} ({members.length})
                </span>

                {isLoadingMembers ? (
                  <div className="space-y-2 py-2" data-testid="members-loading-skeleton">
                    <SkeletonListItem />
                    <SkeletonListItem />
                  </div>
                ) : membersError ? (
                  <div className="py-4 text-center text-xs text-red-400" role="alert">
                    {membersError}
                  </div>
                ) : (
                  <div className="divide-y divide-border rounded-lg border border-border bg-surface-2">
                    {members.map((m) => {
                      const isMe = m.userId === currentUserId;
                      const displayName =
                        m.user?.name || m.user?.email || t('workspaces.roleMember');
                      const displayEmail = m.user?.email || '';

                      // Only administrators may change or remove other administrators.
                      const canTouch = isAdmin || m.role !== 'ADMIN';
                      const editingAccess = accessDraft?.memberId === m.id;

                      return (
                        <div key={m.id} data-testid={`member-row-${m.id}`}>
                          <div className="flex items-center justify-between gap-3 p-3 text-xs">
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
                                {m.role === 'ADMIN' ? (
                                  <span className="block text-[10px] text-muted">
                                    {t('permissions.adminHasAll')}
                                  </span>
                                ) : m.groupIds?.length ? (
                                  <span className="mt-1 flex flex-wrap gap-1">
                                    {m.groupIds.map((id) => (
                                      <span
                                        key={id}
                                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]"
                                      >
                                        {groupName(id) ?? id}
                                      </span>
                                    ))}
                                  </span>
                                ) : (
                                  m.groupIds && (
                                    <span className="block text-[10px] text-amber-400">
                                      {t('permissions.noGroupsWarning')}
                                    </span>
                                  )
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {(canManageRoles || canManageGroups) &&
                                canTouch &&
                                m.role !== 'ADMIN' && (
                                  <Button
                                    type="button"
                                    variant={editingAccess ? 'secondary' : 'ghost'}
                                    size="sm"
                                    aria-expanded={editingAccess}
                                    aria-label={`${t('permissions.editPermissions')} ${displayName}`}
                                    onClick={() =>
                                      setAccessDraft(
                                        editingAccess
                                          ? null
                                          : {
                                              memberId: m.id,
                                              permissions: m.permissions ?? {},
                                              groupIds: m.groupIds ?? [],
                                            },
                                      )
                                    }
                                  >
                                    <i className="ti ti-shield-lock" aria-hidden="true" />
                                    {t('permissions.editPermissions')}
                                  </Button>
                                )}
                              {canManageRoles && canTouch ? (
                                <div className="w-32">
                                  <Select
                                    selectSize="sm"
                                    value={m.role}
                                    onChange={(e) => {
                                      void handleRoleChange(m.id, e.target.value as WorkspaceRole);
                                    }}
                                    aria-label={`${t('common.role')} ${displayName}`}
                                  >
                                    {isAdmin && (
                                      <option value="ADMIN">{t('workspaces.roleAdmin')}</option>
                                    )}
                                    <option value="INTEGRATOR">
                                      {t('workspaces.roleIntegrator')}
                                    </option>
                                    <option value="MEMBER">{t('workspaces.roleMember')}</option>
                                    <option value="VIEWER">{t('workspaces.roleViewer')}</option>
                                  </Select>
                                </div>
                              ) : (
                                <span
                                  className={cn(
                                    'rounded border px-2 py-0.5 text-[10px] font-medium leading-none',
                                    getRoleBadgeClass(m.role),
                                  )}
                                >
                                  {getRoleLabel(m.role)}
                                </span>
                              )}

                              {canRemoveMembers && canTouch && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    void handleRemoveMember(m.id);
                                  }}
                                  className="text-muted hover:bg-red-500/10 hover:text-red-400"
                                  title={t('workspaces.removeMember')}
                                  aria-label={`Remover ${displayName}`}
                                >
                                  <i className="ti ti-trash text-sm" aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          </div>
                          {editingAccess && accessDraft && (
                            <div
                              className="space-y-3 border-t border-border bg-surface-1 p-3 text-xs"
                              data-testid={`member-access-${m.id}`}
                            >
                              {canManageRoles && (
                                <fieldset className="space-y-1">
                                  <legend className="font-semibold text-[var(--text-primary)]">
                                    {t('permissions.workspaceSection')}
                                  </legend>
                                  <p className="text-[11px] text-muted">
                                    {t('permissions.workspaceSectionDesc')}
                                  </p>
                                  <div className="grid gap-1 sm:grid-cols-2">
                                    {WORKSPACE_PERMISSION_KEYS.map(
                                      (key: WorkspacePermissionKey) => (
                                        <label
                                          key={key}
                                          className="flex cursor-pointer items-center gap-2"
                                        >
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
                                            checked={accessDraft.permissions[key] === true}
                                            // Members can only grant what they hold themselves.
                                            disabled={!workspaceAccess[key]}
                                            onChange={(event) =>
                                              setAccessDraft({
                                                ...accessDraft,
                                                permissions: {
                                                  ...accessDraft.permissions,
                                                  [key]: event.target.checked,
                                                },
                                              })
                                            }
                                          />
                                          {t(`permissions.workspace.${key}`)}
                                        </label>
                                      ),
                                    )}
                                  </div>
                                </fieldset>
                              )}
                              {canManageGroups && (
                                <fieldset className="space-y-1">
                                  <legend className="font-semibold text-[var(--text-primary)]">
                                    {t('permissions.memberGroups')}
                                  </legend>
                                  {groups.length === 0 ? (
                                    <p className="text-muted">{t('permissions.noGroups')}</p>
                                  ) : (
                                    <div className="grid gap-1 sm:grid-cols-2">
                                      {groups.map((group) => (
                                        <label
                                          key={group.id}
                                          className="flex cursor-pointer items-center gap-2"
                                        >
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
                                            checked={accessDraft.groupIds.includes(group.id)}
                                            onChange={() =>
                                              setAccessDraft({
                                                ...accessDraft,
                                                groupIds: accessDraft.groupIds.includes(group.id)
                                                  ? accessDraft.groupIds.filter(
                                                      (id) => id !== group.id,
                                                    )
                                                  : [...accessDraft.groupIds, group.id],
                                              })
                                            }
                                          />
                                          {group.name}
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </fieldset>
                              )}
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setAccessDraft(null)}
                                >
                                  {t('common.cancel')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void handleSaveAccess(accessDraft)}
                                >
                                  {t('common.save')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {settingsSection === 'groups' && canManageGroups && apiClient && activeMembership && (
            <div className="rounded-xl border border-border bg-surface-1 p-5 shadow-sm">
              <PermissionGroupsPanel
                apiClient={apiClient}
                workspaceId={activeMembership.workspace.id}
                groups={groups}
                members={members}
                onChanged={reloadAccess}
              />
            </div>
          )}

          {/* Zona de Perigo: Exclusão do Workspace Ativo */}
          {canDeleteWorkspace && activeMembership && (
            <div
              className={cn(
                'rounded-xl border border-red-500/30 bg-red-500/5 p-5 shadow-sm',
                settingsSection !== 'workspace' && 'hidden',
              )}
              data-testid="workspace-danger-zone"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-red-400">{t('settings.dangerZone')}</h3>
                  <p className="text-xs text-muted">
                    {t('settings.deleteWorkspaceDescription', {
                      name: activeMembership.workspace.name,
                    })}
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
                  <div className="flex w-full flex-col gap-3 sm:w-auto sm:min-w-[320px]">
                    <p className="text-xs text-red-300">
                      {t('settings.typeWorkspaceName', {
                        name: activeMembership.workspace.name,
                      })}
                    </p>
                    <Input
                      value={deleteConfirmationName}
                      onChange={(event) => setDeleteConfirmationName(event.target.value)}
                      placeholder={activeMembership.workspace.name}
                      disabled={isDeleting}
                      aria-label={t('settings.workspaceNameConfirmation')}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={
                          isDeleting ||
                          deleteConfirmationName.trim() !== activeMembership.workspace.name
                        }
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

              {deleteError && (
                <div className="mt-3 text-xs text-red-400" role="alert">
                  {deleteError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ConfirmationDialog
        open={isFinalDeleteConfirmationOpen}
        title={t('settings.deleteWorkspacePermanently')}
        description={t('settings.deleteWorkspaceDescription', {
          name: activeMembership?.workspace.name ?? '',
        })}
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
