import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { allows, toggleOperation } from '../workspaces/permissions.js';
import {
  PERMISSION_MODULES,
  type ModuleAccessMap,
  type ModuleOperation,
  type PermissionGroup,
  type WorkspaceMember,
} from '../workspaces/workspace-types.js';

const OPERATIONS: readonly ModuleOperation[] = ['view', 'edit', 'delete'];

interface Draft {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly modules: ModuleAccessMap;
  readonly memberIds: readonly string[];
}

export function PermissionGroupsPanel({
  apiClient,
  workspaceId,
  groups,
  members,
  onChanged,
}: {
  apiClient: ApiClient;
  workspaceId: string;
  groups: readonly PermissionGroup[];
  members: readonly WorkspaceMember[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<PermissionGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const memberName = (member: WorkspaceMember) =>
    member.user?.name || member.user?.email || member.userId;

  const save = async (event: FormEvent, draft: Draft) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiClient.savePermissionGroup(
        workspaceId,
        {
          name: draft.name,
          description: draft.description,
          modules: draft.modules,
          memberIds: draft.memberIds,
        },
        draft.id,
      );
      setDraft(null);
      setNotice(t('permissions.groupSaved'));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('permissions.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (group: PermissionGroup) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.deletePermissionGroup(workspaceId, group.id);
      setNotice(t('permissions.groupDeleted'));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('permissions.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="permission-groups-panel">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {t('permissions.section')}
          </h2>
          <p className="text-xs text-muted">{t('permissions.sectionDesc')}</p>
        </div>
        {!draft && (
          <Button
            type="button"
            size="sm"
            leftIcon={<i className="ti ti-plus" aria-hidden="true" />}
            onClick={() => {
              setNotice(null);
              setDraft({ name: '', description: '', modules: {}, memberIds: [] });
            }}
          >
            {t('permissions.newGroup')}
          </Button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-400"
        >
          {notice}
        </div>
      )}

      {draft ? (
        <form
          onSubmit={(event) => void save(event, draft)}
          className="space-y-4 rounded-lg border border-border bg-surface-2 p-4"
          aria-label={draft.id ? t('permissions.editGroup') : t('permissions.newGroup')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-[var(--text-secondary)]">
              <span>{t('permissions.groupName')}</span>
              <Input
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="space-y-1 text-xs text-[var(--text-secondary)]">
              <span>{t('permissions.groupDescription')}</span>
              <Textarea
                rows={2}
                maxLength={500}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-1 text-[var(--text-secondary)]">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    {t('permissions.module')}
                  </th>
                  {OPERATIONS.map((operation) => (
                    <th key={operation} scope="col" className="px-3 py-2 text-center font-semibold">
                      {t(`permissions.${operation}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_MODULES.map((module) => (
                  <tr key={module} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      {t(`permissions.modules.${module}`)}
                    </th>
                    {OPERATIONS.map((operation) => (
                      <td key={operation} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
                          aria-label={t('permissions.accessFor', {
                            operation: t(`permissions.${operation}`),
                            module: t(`permissions.modules.${module}`),
                          })}
                          checked={allows(draft.modules[module], operation)}
                          onChange={() =>
                            setDraft({
                              ...draft,
                              modules: {
                                ...draft.modules,
                                [module]: toggleOperation(draft.modules[module], operation),
                              },
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-[var(--text-primary)]">
              {t('permissions.groupMembers')}
            </legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {members.map((member) => (
                <label
                  key={member.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--fill-ghost-hover)]"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
                    checked={draft.memberIds.includes(member.id)}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        memberIds: draft.memberIds.includes(member.id)
                          ? draft.memberIds.filter((id) => id !== member.id)
                          : [...draft.memberIds, member.id],
                      })
                    }
                  />
                  <span className="truncate">{memberName(member)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" isLoading={busy}>
              {t('permissions.saveGroup')}
            </Button>
          </div>
        </form>
      ) : groups.length === 0 ? (
        <p className="text-xs text-muted">{t('permissions.noGroups')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2">
          {groups.map((group) => (
            <li
              key={group.id}
              className="flex flex-col gap-2 p-3 text-xs sm:flex-row sm:items-center"
              data-testid={`permission-group-${group.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-[var(--text-primary)]">{group.name}</p>
                {group.description && <p className="text-muted">{group.description}</p>}
                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                  {t('permissions.membersCount', { count: group.memberIds.length })} ·{' '}
                  {PERMISSION_MODULES.filter((module) => allows(group.modules[module], 'view'))
                    .map(
                      (module) =>
                        `${t(`permissions.modules.${module}`)}: ${t(
                          `permissions.${group.modules[module] as ModuleOperation}`,
                        )}`,
                    )
                    .join(' · ')}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`${t('permissions.editGroup')} ${group.name}`}
                  onClick={() => {
                    setNotice(null);
                    setDraft({
                      id: group.id,
                      name: group.name,
                      description: group.description,
                      modules: group.modules,
                      memberIds: group.memberIds,
                    });
                  }}
                >
                  <i className="ti ti-edit" aria-hidden="true" />
                  {t('common.edit')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300"
                  aria-label={`${t('permissions.deleteGroup')} ${group.name}`}
                  onClick={() => setToDelete(group)}
                >
                  <i className="ti ti-trash" aria-hidden="true" />
                  {t('common.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmationDialog
        open={Boolean(toDelete)}
        title={t('permissions.deleteGroup')}
        description={t('permissions.deleteGroupConfirm', { name: toDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        isLoading={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          const group = toDelete!;
          setToDelete(null);
          void remove(group);
        }}
      />
    </div>
  );
}
