import { spawn } from 'node:child_process';
import { mkdirSync, watch as fsWatch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { registerAppScheme, serveWebApp } from './app-protocol.js';
import { APP_ORIGIN, apiUrl, backendEnvironment, mcpEnvironment, mcpUrl } from './env.js';
import { readEnvValue } from './backup-format.js';
import {
  backupKind,
  readBackupHeader,
  restoreBackup,
  restoreSqlDump,
  writeBackup,
} from './backup.js';
import {
  describeCloudUrl,
  explainCloudError,
  inspectCloudDatabase,
  openSecret,
  parseCloudUrl,
  sealSecret,
  type CloudInspection,
  type CloudTarget,
  type SecretCipher,
} from './cloud-database.js';
import { handleDevelopmentCalls } from './development-ipc.js';
import { debounce, liveModeFromEnv } from './live.js';
import { migrationNames } from './migrations.js';
import { CloudDatabase, LocalDatabase, stopLeftoverServer, type AdkDatabase } from './postgres.js';
import { pickPort } from './ports.js';
import { Service, waitForHttp } from './services.js';
import { checkForUpdates } from './updates.js';
import {
  completeSettings,
  readSettingsFile,
  writeSettingsFile,
  type DesktopSettings,
} from './settings.js';

app.setName('Agent DevKit');
registerAppScheme();

const live = liveModeFromEnv(process.env, app.getAppPath(), app.isPackaged);
// Live development keeps its own data, apart from the installed app's.
if (live) app.setPath('userData', join(app.getPath('appData'), 'Agent DevKit Dev'));

const userData = app.getPath('userData');
const dirs = {
  settings: join(userData, 'settings.json'),
  postgres: join(userData, 'database'),
  logs: join(userData, 'logs'),
  browsers: join(userData, 'browsers'),
  backups: join(userData, 'backups'),
};
// Packaged: electron-builder copies stage/ into the resources folder; in development it is stage/.
const stage = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'stage');
const backendDir = live?.backendDir ?? join(stage, 'backend');
const mcpDir = live?.mcpDir ?? join(stage, 'mcp');
const migrationsDir = live?.migrationsDir ?? join(backendDir, 'prisma', 'migrations');
const webOrigin = live?.webOrigin ?? APP_ORIGIN;
const webUrl = live?.webUrl ?? `${APP_ORIGIN}/`;

let settings: DesktopSettings | undefined;
let database: AdkDatabase | undefined;
/** The hosted database in use, opened from the settings; undefined while the data is local. */
let cloudUrl: string | undefined;
let backend: Service | undefined;
let mcp: Service | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let busy = false;
let webAppServed = false;
let development: { stop(): void } | undefined;

const log = (line: string) => console.log(line);
const stamp = () => new Date().toISOString().slice(0, 19).replaceAll(':', '-');

const loadingPage = (text: string): string =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<body style="margin:0;height:100vh;display:grid;place-items:center;font:16px system-ui;` +
      `background:#0f1115;color:#e6e8ec"><div style="text-align:center"><h2>Agent DevKit</h2>` +
      `<p style="opacity:.7">${text}</p></div></body>`,
  );

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: 'Agent DevKit',
    backgroundColor: '#0f1115',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links to other sites open in the user's browser, never inside the app.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === webOrigin) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  return created;
}

/** Installs the browser E2E tests drive (about 150 MB); it is downloaded only when asked. */
function installE2eBrowser(): void {
  const cli = join(backendDir, 'node_modules', 'playwright', 'cli.js');
  const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: dirs.browsers,
    },
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.once('exit', (code) => {
    void dialog.showMessageBox({
      type: code === 0 ? 'info' : 'error',
      message: code === 0 ? 'The E2E browser is installed.' : 'Could not install the E2E browser.',
      detail: code === 0 ? 'You can now run E2E tests.' : output.slice(-1500),
    });
  });
  void dialog.showMessageBox({
    message: 'Installing the E2E browser…',
    detail: 'It downloads in the background; you will be told when it finishes.',
  });
}

function buildMenu(): void {
  const open = (path: string) => () => void shell.openPath(path);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'ADK',
        submenu: [
          {
            label: 'Copy MCP server address',
            click: () => {
              if (settings) void clipboard.writeText(mcpUrl(settings));
            },
          },
          { label: 'Install E2E browser…', click: () => installE2eBrowser() },
          { type: 'separator' },
          { label: 'Back up data…', click: () => void backUp() },
          { label: 'Restore data…', click: () => void restore() },
          { type: 'separator' },
          { label: 'Open data folder', click: open(userData) },
          { label: 'Open logs folder', click: open(dirs.logs) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('Agent DevKit could not start', `${message}\n\nLogs: ${dirs.logs}`);
  app.exit(1);
}

async function startEverything(): Promise<void> {
  for (const dir of [dirs.logs, dirs.browsers]) mkdirSync(dir, { recursive: true });
  // Before choosing ports: a database left running by a crash still holds its port.
  await stopLeftoverServer(dirs.postgres, log);
  settings = await completeSettings(await readSettingsFile(dirs.settings), pickPort);
  await writeSettingsFile(dirs.settings, settings);

  if (settings.cloudDatabase) await startCloudDatabase();
  else await startLocalDatabase();
  await startServices();
  if (live) watchLiveBuilds();
  else checkForUpdates(log);
}

async function startLocalDatabase(): Promise<void> {
  if (!settings) return;
  void window?.loadURL(loadingPage('Starting the database…'));
  cloudUrl = undefined;
  database = new LocalDatabase(settings, dirs.postgres, log);
  await database.start(migrationsDir);
}

/**
 * Connects to the hosted database saved in the settings. When it cannot be reached the user
 * chooses: try again, go back to the data on this computer, or quit.
 */
async function startCloudDatabase(): Promise<void> {
  for (;;) {
    const saved = settings?.cloudDatabase;
    if (!saved) return startLocalDatabase();
    void window?.loadURL(loadingPage('Connecting to the cloud database…'));
    try {
      const url = openSecret(saved.url, cipher);
      const cloud = new CloudDatabase(url);
      await cloud.start(migrationsDir);
      cloudUrl = url;
      database = cloud;
      return;
    } catch (error) {
      const answer = await dialog.showMessageBox({
        type: 'error',
        message: 'The cloud database cannot be reached.',
        detail:
          `${explainCloudError(error)}\n\nUsing the data on this computer disconnects the cloud ` +
          'database; the data in it stays there and you can connect again in Integrations.',
        buttons: ['Try again', 'Use the data on this computer', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      });
      if (answer.response === 2) {
        app.exit(0);
        return;
      }
      if (answer.response === 1) {
        await saveCloudSettings(undefined);
        return startLocalDatabase();
      }
    }
  }
}

/** Seals the cloud database URL with the system keychain (DPAPI on Windows). */
const cipher: SecretCipher = {
  get available() {
    return safeStorage.isEncryptionAvailable();
  },
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
};

async function saveCloudSettings(cloud: DesktopSettings['cloudDatabase']): Promise<void> {
  if (!settings) return;
  const { cloudDatabase: _previous, ...rest } = settings;
  settings = cloud ? { ...rest, cloudDatabase: cloud } : rest;
  await writeSettingsFile(dirs.settings, settings);
}

/** The key that encrypts the integrations of the database in use. */
function activeEncryptionKey(current: DesktopSettings): string {
  return cloudUrl && current.cloudDatabase
    ? current.cloudDatabase.integrationEncryptionKey
    : current.integrationEncryptionKey;
}

const apiHealth = (current: DesktopSettings) => `${apiUrl(current)}/health`;
const mcpHealth = (current: DesktopSettings) => `http://127.0.0.1:${current.mcpPort}/healthz`;

function onUnexpectedExit(name: string, code: number | null): void {
  if (quitting) return;
  // While developing, a crash is usually a bug being fixed: the next build restarts it.
  if (live) log(`[live] The ${name} stopped (exit code ${code}); it restarts on the next build.`);
  else fail(new Error(`The ${name} stopped unexpectedly (exit code ${code}).`));
}

function createBackend(current: DesktopSettings): Service {
  return new Service({
    name: 'API',
    script: join(backendDir, 'dist', 'src', 'bootstrap', 'server.js'),
    cwd: backendDir,
    environment: backendEnvironment(current, {
      browsersPath: dirs.browsers,
      dataDir: userData,
      ...(live ? { frontendUrl: live.webOrigin } : {}),
      ...(cloudUrl && current.cloudDatabase
        ? {
            cloud: {
              url: cloudUrl,
              integrationEncryptionKey: current.cloudDatabase.integrationEncryptionKey,
            },
          }
        : {}),
    }),
    logFile: join(dirs.logs, 'api.log'),
    onUnexpectedExit,
  });
}

function createMcp(current: DesktopSettings): Service {
  return new Service({
    name: 'MCP server',
    script: join(mcpDir, 'dist', 'src', 'bin', 'devkit-mcp.js'),
    args: ['http'],
    cwd: mcpDir,
    environment: mcpEnvironment(current),
    logFile: join(dirs.logs, 'mcp.log'),
    onUnexpectedExit,
  });
}

/** Starts the API and the MCP server and shows the web app once both answer. */
async function startServices(): Promise<void> {
  if (!settings) return;
  void window?.loadURL(loadingPage('Starting ADK…'));
  backend = createBackend(settings);
  backend.start();
  mcp = createMcp(settings);
  mcp.start();
  await Promise.all([
    waitForHttp(apiHealth(settings), 120_000),
    waitForHttp(mcpHealth(settings), 60_000),
  ]);

  if (!live && !webAppServed) serveWebApp(join(stage, 'frontend'));
  webAppServed = true;
  await window?.loadURL(webUrl);
}

/**
 * Live mode: `tsc --watch` (started by scripts/dev-live.mjs) rewrites dist/ on every save; the
 * service whose output changed restarts once the burst of writes settles. The web app itself
 * reloads through Vite.
 */
function watchLiveBuilds(): void {
  const restart = async (name: 'API' | 'MCP server') => {
    if (!settings || quitting || busy) return;
    log(`[live] Restarting the ${name}…`);
    const started = Date.now();
    try {
      if (name === 'API') {
        await backend?.stop();
        backend = createBackend(settings);
        backend.start();
        await waitForHttp(apiHealth(settings), 60_000);
      } else {
        await mcp?.stop();
        mcp = createMcp(settings);
        mcp.start();
        await waitForHttp(mcpHealth(settings), 60_000);
      }
      log(`[live] The ${name} is back (${Date.now() - started} ms).`);
    } catch (error) {
      log(`[live] The ${name} did not come back: ${String(error)}. See ${dirs.logs}.`);
    }
  };
  const watch = (dir: string, name: 'API' | 'MCP server') => {
    const schedule = debounce(() => void restart(name), 600);
    fsWatch(dir, { recursive: true }, (_event, file) => {
      if (file?.endsWith('.js')) schedule();
    });
  };
  watch(join(backendDir, 'dist', 'src'), 'API');
  watch(join(mcpDir, 'dist', 'src'), 'MCP server');
  log(`[live] Watching ${backendDir} and ${mcpDir}; the window shows ${webUrl}.`);
}

async function stopServices(): Promise<void> {
  await mcp?.stop();
  await backend?.stop();
}

function showError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void dialog.showMessageBox({ type: 'error', message: title, detail: message });
}

/** Saves every row to a file the user picks; ADK keeps running meanwhile. */
async function backUp(): Promise<void> {
  if (!database || !settings || busy) return;
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Back up Agent DevKit data',
    defaultPath: join(app.getPath('documents'), `agent-devkit-${stamp()}.adkbackup`),
    filters: [{ name: 'Agent DevKit backup', extensions: ['adkbackup'] }],
  });
  if (canceled || !filePath) return;
  busy = true;
  try {
    const key = activeEncryptionKey(settings);
    const summary = await database.withClient((client) => writeBackup(client, filePath, key));
    await dialog.showMessageBox({
      message: 'Backup saved.',
      detail:
        `${summary.rows} rows from ${summary.tables} tables in ${filePath}.\n\n` +
        'It includes the key that reads your saved integrations: keep it somewhere private.',
    });
  } catch (error) {
    showError('The backup failed.', error);
  } finally {
    busy = false;
  }
}

/** Asks for the .env of the Docker install and returns its encryption key ('' to go without). */
async function dockerEncryptionKey(): Promise<string | undefined> {
  const answer = await dialog.showMessageBox({
    type: 'question',
    message: 'Is this a dump of the Docker install?',
    detail:
      'To keep its saved integrations readable, choose the .env file of that install (in the ADK ' +
      'folder): it holds the key they were encrypted with. Without it, integrations must be ' +
      'entered again.',
    buttons: ['Choose .env…', 'Continue without it', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (answer.response === 2) return undefined;
  if (answer.response === 1) return '';
  const env = await dialog.showOpenDialog({
    title: 'The .env file of the Docker install',
    properties: ['openFile', 'showHiddenFiles'],
  });
  const envFile = env.filePaths[0];
  if (env.canceled || !envFile) return undefined;
  const key = readEnvValue(await readFile(envFile, 'utf8'), 'INTEGRATION_ENCRYPTION_KEY');
  if (!key)
    showError('That .env has no INTEGRATION_ENCRYPTION_KEY.', 'Choose the .env of the ADK folder.');
  return key;
}

/**
 * Replaces all data with a desktop backup, or with a data-only SQL dump of the Docker install.
 * The current data is backed up first and put back if anything fails.
 */
async function restore(): Promise<void> {
  if (!database || !settings || busy) return;
  const picked = await dialog.showOpenDialog({
    title: 'Restore Agent DevKit data',
    properties: ['openFile'],
    filters: [
      { name: 'Agent DevKit backup or SQL dump', extensions: ['adkbackup', 'sql'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  const file = picked.filePaths[0];
  if (picked.canceled || !file) return;

  let kind: 'backup' | 'sql';
  let restoredKey: string | undefined;
  try {
    kind = await backupKind(file);
    if (kind === 'backup') restoredKey = (await readBackupHeader(file)).integrationEncryptionKey;
  } catch (error) {
    showError('This file cannot be restored.', error);
    return;
  }
  if (kind === 'sql') {
    restoredKey = await dockerEncryptionKey();
    if (restoredKey === undefined) return;
  }
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    message: 'Replace all data in Agent DevKit?',
    detail:
      'Everything in this app is replaced by the file. A backup of the current data is saved ' +
      `first in ${dirs.backups}.`,
    buttons: ['Replace data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (confirm.response !== 0) return;

  busy = true;
  const db = database;
  const current = settings;
  const safety = join(dirs.backups, `before-restore-${stamp()}.adkbackup`);
  let stopped = false;
  const load = (source: string, type: 'backup' | 'sql'): Promise<unknown> =>
    db.withClient<unknown>((client) =>
      type === 'backup'
        ? restoreBackup(client, source, migrationsDir)
        : restoreSqlDump(client, source, migrationsDir),
    );
  try {
    mkdirSync(dirs.backups, { recursive: true });
    void window?.loadURL(loadingPage('Saving the current data…'));
    await db.withClient((client) => writeBackup(client, safety, activeEncryptionKey(current)));
    void window?.loadURL(loadingPage('Restoring…'));
    stopped = true;
    await stopServices();
    try {
      await db.recreateDatabase();
      await load(file, kind);
    } catch (error) {
      void window?.loadURL(loadingPage('The restore failed. Putting the previous data back…'));
      await db.recreateDatabase();
      await load(safety, 'backup');
      throw error;
    }
    if (restoredKey && restoredKey !== activeEncryptionKey(current)) {
      settings = current.cloudDatabase
        ? {
            ...current,
            cloudDatabase: { ...current.cloudDatabase, integrationEncryptionKey: restoredKey },
          }
        : { ...current, integrationEncryptionKey: restoredKey };
      await writeSettingsFile(dirs.settings, settings);
    }
    await startServices();
    await dialog.showMessageBox({
      message: 'Data restored.',
      detail: `The previous data is saved in ${safety}.`,
    });
  } catch (error) {
    if (stopped) await startServices().catch(fail);
    else void window?.loadURL(webUrl);
    showError('The restore failed, so the previous data was kept.', error);
  } finally {
    busy = false;
  }
}

// ---- Cloud database, driven from Integrations > Storage in the web app (see src/preload) ----

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

interface StorageStatus {
  readonly mode: 'local' | 'cloud';
  readonly target?: CloudTarget;
  readonly busy: boolean;
}

function storageStatus(): StorageStatus {
  return {
    mode: cloudUrl ? 'cloud' : 'local',
    ...(cloudUrl ? { target: describeCloudUrl(cloudUrl) } : {}),
    busy,
  };
}

async function inspectCloud(
  rawUrl: unknown,
): Promise<Outcome<{ url: string; inspection: CloudInspection; target: CloudTarget }>> {
  try {
    const url = parseCloudUrl(typeof rawUrl === 'string' ? rawUrl : '');
    const known = await migrationNames(migrationsDir);
    const inspection = await new CloudDatabase(url).withClient((client) =>
      inspectCloudDatabase(client, known),
    );
    return { ok: true, url, inspection, target: describeCloudUrl(url) };
  } catch (error) {
    return { ok: false, error: explainCloudError(error) };
  }
}

function refusal(inspection: CloudInspection): string | undefined {
  if (inspection.kind === 'other')
    return 'This database already has tables that are not from ADK. Use an empty database.';
  if (inspection.unknownMigrations.length > 0)
    return 'This database was used by a newer version of Agent DevKit. Update the app first.';
  return undefined;
}

/**
 * Moves ADK to a hosted PostgreSQL. An empty one receives a copy of this computer's data (or
 * starts empty); one that already holds ADK data is used as it is. The data on this computer is
 * left untouched, so disconnecting can go back to it.
 */
async function connectCloud(input: {
  readonly url?: unknown;
  readonly copyLocalData?: unknown;
  readonly integrationEncryptionKey?: unknown;
}): Promise<Outcome> {
  if (!settings || !database || busy) return { ok: false, error: 'Agent DevKit is busy.' };
  if (cloudUrl) return { ok: false, error: 'A cloud database is already in use.' };
  const checked = await inspectCloud(input.url);
  if (!checked.ok) return checked;
  const refused = refusal(checked.inspection);
  if (refused) return { ok: false, error: refused };
  const givenKey =
    typeof input.integrationEncryptionKey === 'string' ? input.integrationEncryptionKey.trim() : '';
  if (givenKey && givenKey.length < 32)
    return {
      ok: false,
      error: 'The encryption key is too short. Copy it again from the other computer.',
    };

  busy = true;
  const local = database;
  const current = settings;
  const cloud = new CloudDatabase(checked.url);
  const copy = checked.inspection.kind === 'empty' && input.copyLocalData !== false;
  let stopped = false;
  try {
    void window?.loadURL(loadingPage('Moving to the cloud database…'));
    stopped = true;
    await stopServices();
    if (copy) {
      mkdirSync(dirs.backups, { recursive: true });
      const file = join(dirs.backups, `to-cloud-${stamp()}.adkbackup`);
      await local.withClient((client) =>
        writeBackup(client, file, current.integrationEncryptionKey),
      );
      void window?.loadURL(loadingPage('Copying your data to the cloud database…'));
      try {
        await cloud.withClient((client) => restoreBackup(client, file, migrationsDir));
      } catch (error) {
        // Leave the cloud database empty, as it was, so the user can try again.
        await cloud.recreateDatabase().catch(() => undefined);
        throw error;
      }
    } else {
      void window?.loadURL(loadingPage('Preparing the cloud database…'));
      await cloud.start(migrationsDir);
    }
    await saveCloudSettings({
      url: sealSecret(checked.url, cipher),
      integrationEncryptionKey:
        checked.inspection.kind === 'adk' && givenKey ? givenKey : current.integrationEncryptionKey,
    });
    cloudUrl = checked.url;
    database = cloud;
    await local.stop().catch(() => undefined);
    await startServices();
    return { ok: true };
  } catch (error) {
    if (stopped) await startServices().catch(fail);
    return { ok: false, error: explainCloudError(error) };
  } finally {
    busy = false;
  }
}

/**
 * Goes back to the database on this computer. With copyCloudData the cloud data replaces it (a
 * backup of it is saved first); otherwise it comes back as it was before connecting. The cloud
 * database is not changed either way.
 */
async function disconnectCloud(input: { readonly copyCloudData?: unknown }): Promise<Outcome> {
  if (!settings || !database || busy) return { ok: false, error: 'Agent DevKit is busy.' };
  if (!cloudUrl) return { ok: false, error: 'No cloud database is in use.' };
  busy = true;
  const cloud = database;
  const current = settings;
  const cloudKey = activeEncryptionKey(current);
  let local: LocalDatabase | undefined;
  try {
    void window?.loadURL(loadingPage('Going back to the data on this computer…'));
    await stopServices();
    let fromCloud: string | undefined;
    if (input.copyCloudData === true) {
      mkdirSync(dirs.backups, { recursive: true });
      const file = join(dirs.backups, `from-cloud-${stamp()}.adkbackup`);
      await cloud.withClient((client) => writeBackup(client, file, cloudKey));
      fromCloud = file;
    }
    local = new LocalDatabase(current, dirs.postgres, log);
    await local.start(migrationsDir);
    if (fromCloud) {
      const target = local;
      const cloudBackup = fromCloud;
      void window?.loadURL(loadingPage('Copying the cloud data to this computer…'));
      const safety = join(dirs.backups, `before-cloud-copy-${stamp()}.adkbackup`);
      await target.withClient((client) =>
        writeBackup(client, safety, current.integrationEncryptionKey),
      );
      try {
        await target.recreateDatabase();
        await target.withClient((client) => restoreBackup(client, cloudBackup, migrationsDir));
      } catch (error) {
        await target.recreateDatabase();
        await target.withClient((client) => restoreBackup(client, safety, migrationsDir));
        throw error;
      }
    }
    database = local;
    cloudUrl = undefined;
    await saveCloudSettings(undefined);
    if (fromCloud && settings && cloudKey !== settings.integrationEncryptionKey) {
      // The copied integrations were encrypted with the cloud database's key.
      settings = { ...settings, integrationEncryptionKey: cloudKey };
      await writeSettingsFile(dirs.settings, settings);
    }
    await startServices();
    return { ok: true };
  } catch (error) {
    // Still on the cloud database: the local one goes back to sleep.
    if (database === cloud) await local?.stop().catch(() => undefined);
    await startServices().catch(fail);
    return { ok: false, error: explainCloudError(error) };
  } finally {
    busy = false;
  }
}

/** Only the web app shown in this window may drive these calls. */
function fromWebApp(event: IpcMainInvokeEvent): boolean {
  try {
    return new URL(event.senderFrame?.url ?? '').origin === new URL(webUrl).origin;
  } catch {
    return false;
  }
}

function handleStorageCalls(): void {
  const denied: Outcome = { ok: false, error: 'Not allowed.' };
  ipcMain.handle('adk:storage-status', (event) => (fromWebApp(event) ? storageStatus() : denied));
  ipcMain.handle('adk:storage-inspect', async (event, url: unknown) => {
    if (!fromWebApp(event)) return denied;
    const result = await inspectCloud(url);
    if (!result.ok) return result;
    const refused = refusal(result.inspection);
    return refused
      ? { ok: false, error: refused }
      : { ok: true, inspection: result.inspection, target: result.target };
  });
  ipcMain.handle('adk:storage-connect', (event, input: Parameters<typeof connectCloud>[0]) =>
    fromWebApp(event) ? connectCloud(input ?? {}) : denied,
  );
  ipcMain.handle('adk:storage-disconnect', (event, input: Parameters<typeof disconnectCloud>[0]) =>
    fromWebApp(event) ? disconnectCloud(input ?? {}) : denied,
  );
  ipcMain.handle('adk:storage-copy-key', (event) => {
    if (!fromWebApp(event) || !settings || !cloudUrl) return denied;
    void clipboard.writeText(activeEncryptionKey(settings));
    return { ok: true };
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  ipcMain.on('adk:api-url', (event) => {
    event.returnValue = settings ? apiUrl(settings) : '';
  });
  handleStorageCalls();
  development = handleDevelopmentCalls({
    apiUrl: () => (settings ? apiUrl(settings) : ''),
    userData,
    log,
    allowed: fromWebApp,
    window: () => window,
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      // Agents and terminal commands first: they report to the API while it still answers.
      development?.stop();
      await stopServices();
      await database?.stop().catch(() => undefined);
      app.exit(0);
    })();
  });

  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(async () => {
    buildMenu();
    window = createWindow();
    void window.loadURL(loadingPage('Starting…'));
    await startEverything().catch(fail);
  });
}
