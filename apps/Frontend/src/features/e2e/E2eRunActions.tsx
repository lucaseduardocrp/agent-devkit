import { useState, type ReactNode } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { E2eImportCasesDialog, E2eReportingDialog } from './E2eTestManagement.js';
import { isCreationActive, needsPolling, type E2eCreationSummary } from './e2e-types.js';

/** What the menu of a run needs to know about it; both the list and the run page have it. */
export type E2eRunActionsTarget = Pick<
  E2eCreationSummary,
  'id' | 'name' | 'mode' | 'repository' | 'reporting' | 'status' | 'lastReport'
>;

export interface E2eRunActionsProps {
  readonly apiClient: ApiClient;
  readonly creation: E2eRunActionsTarget;
  readonly onEdit: () => void;
  /** Leave it out where the page already has its own button for it. */
  readonly onExplore?: () => void;
  /** Leave it out where the page already has its own button to run everything again. */
  readonly onRerun?: false;
  /** Something changed on the server (rerun, cancel, pull, reporting...): load the run again. */
  readonly onChanged: () => void;
  /** The run no longer exists. */
  readonly onDeleted: () => void;
  readonly onNotice: (message: string | null) => void;
  readonly onError: (message: string | null) => void;
  readonly onOpenIntegrations?: () => void;
}

function MenuItem({
  icon,
  onClick,
  destructive = false,
  children,
}: {
  icon: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      role="menuitem"
      className="flex w-full justify-start text-left"
      {...(destructive ? { 'data-destructive': true } : {})}
      onClick={onClick}
    >
      <i className={`ti ${icon}`} aria-hidden="true" />
      {children}
    </Button>
  );
}

/**
 * The three-dot menu of a run (edit, run again, explore, pull scripts, test management, import,
 * delete) with the dialogs those options open. Shared by the list of runs and the run page.
 */
export function E2eRunActions({
  apiClient,
  creation,
  onEdit,
  onExplore,
  onRerun,
  onChanged,
  onDeleted,
  onNotice,
  onError,
  onOpenIntegrations,
}: E2eRunActionsProps) {
  const { t } = useI18n();
  const { can } = usePermissions();
  // Delete includes edit, so only members who can delete the run get it.
  const canDelete = can('e2e', 'delete');
  // Imported cases come from test plans.
  const canImportCases = can('testplans');
  const [dialog, setDialog] = useState<'reporting' | 'import' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const active = isCreationActive(creation.status);

  const run = async (action: () => Promise<void>) => {
    onError(null);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : t('e2e.actionFailed'));
    }
    onChanged();
  };

  const pullScripts = () => {
    onNotice(null);
    void run(async () => {
      const result = await apiClient.pullE2eCreation(creation.id);
      onNotice(t('e2e.pullResult', { ...result, name: creation.name }));
    });
  };

  const closeDialog = (message: string | null) => {
    setDialog(null);
    onNotice(message);
    onChanged();
  };

  const confirmDelete = async () => {
    setDeleting(true);
    onError(null);
    let deleted = false;
    try {
      await apiClient.deleteE2eCreation(creation.id);
      deleted = true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t('e2e.actionFailed'));
    }
    setDeleting(false);
    setConfirmingDelete(false);
    if (deleted) onDeleted();
    else onChanged();
  };

  return (
    <>
      <ActionsMenu portal>
        {!active && (
          <MenuItem
            icon="ti-pencil"
            onClick={() => {
              onNotice(null);
              onError(null);
              onEdit();
            }}
          >
            {t('e2e.editRun')}
          </MenuItem>
        )}
        {active ? (
          <MenuItem
            icon="ti-player-stop"
            onClick={() => void run(() => apiClient.cancelE2eCreation(creation.id))}
          >
            {t('e2e.cancelRun')}
          </MenuItem>
        ) : (
          onRerun !== false && (
            <MenuItem
              icon="ti-refresh"
              onClick={() => void run(() => apiClient.rerunE2eCreation(creation.id))}
            >
              {t('e2e.rerunAll')}
            </MenuItem>
          )
        )}
        {creation.mode === 'frontend' && onExplore && (
          <MenuItem icon="ti-compass" onClick={onExplore}>
            {t('e2e.exploreSite')}
          </MenuItem>
        )}
        {creation.repository && !active && (
          <MenuItem icon="ti-download" onClick={pullScripts}>
            {t('e2e.pullScripts')}
          </MenuItem>
        )}
        <MenuItem icon="ti-settings" onClick={() => setDialog('reporting')}>
          {t('e2e.tmTitle')}
        </MenuItem>
        {canImportCases && !needsPolling(creation) && (
          <MenuItem icon="ti-file-import" onClick={() => setDialog('import')}>
            {t('e2e.tmImport')}
          </MenuItem>
        )}
        {canDelete && (
          <MenuItem icon="ti-trash" destructive onClick={() => setConfirmingDelete(true)}>
            {t('e2e.deleteRun')}
          </MenuItem>
        )}
      </ActionsMenu>

      {dialog === 'reporting' && (
        <E2eReportingDialog
          apiClient={apiClient}
          creation={creation}
          onClose={() => setDialog(null)}
          onSaved={() => closeDialog(t('e2e.tmReportingSaved', { name: creation.name }))}
          onOpenIntegrations={onOpenIntegrations}
        />
      )}
      {dialog === 'import' && (
        <E2eImportCasesDialog
          apiClient={apiClient}
          creation={creation}
          onClose={() => setDialog(null)}
          onImported={(result) =>
            closeDialog(
              t('e2e.tmImportResult', {
                imported: result.imported,
                skipped: result.skipped,
                name: creation.name,
              }),
            )
          }
          onOpenIntegrations={onOpenIntegrations}
        />
      )}
      {confirmingDelete && (
        <ConfirmationDialog
          open
          title={t('e2e.deleteTitle')}
          description={t('e2e.deleteDescription', { name: creation.name })}
          confirmLabel={t('e2e.deleteConfirm')}
          cancelLabel={t('e2e.cancel')}
          destructive
          isLoading={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </>
  );
}
