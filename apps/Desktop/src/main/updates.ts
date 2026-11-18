import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/**
 * Looks for a newer release on GitHub (the `desktop-v*` releases) and downloads it in the
 * background; the user decides when to restart. Failures only reach the log: being offline, or the
 * latest release being a CLI one, must never bother the user.
 */
export function checkForUpdates(log: (message: string) => void): void {
  if (!app.isPackaged) return;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => log(`[updates] ${error.message}`));
  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        message: `Agent DevKit ${info.version} is ready to install.`,
        detail: 'Restart now to update, or it is installed the next time you close the app.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
  void autoUpdater.checkForUpdates().catch((error: unknown) => log(`[updates] ${String(error)}`));
}
