import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { postmasterPid } from './backup-format.js';
import { clearCloudDatabase } from './cloud-database.js';
import { applyMigrations } from './migrations.js';
import type { DesktopSettings } from './settings.js';

const run = promisify(execFile);
const DATABASE = 'adk';
const USER = 'adk';

/** pg_ctl from the PostgreSQL binaries bundled for this system. */
async function pgCtl(): Promise<string> {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const binaries = (await import(`@embedded-postgres/${platform}-${process.arch}`)) as {
    pg_ctl: string;
  };
  return binaries.pg_ctl;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a PostgreSQL that a crash of the app left running on `dataDir`. It would hold the
 * database files and the port, and the app could not start until the computer restarted.
 */
export async function stopLeftoverServer(
  dataDir: string,
  log: (message: string) => void,
): Promise<void> {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return;
  const pid = postmasterPid(await readFile(pidFile, 'utf8').catch(() => ''));
  if (pid === undefined || !isRunning(pid)) return; // A stale file: PostgreSQL ignores it.
  log(`[postgres] Stopping the database left running by a previous session (pid ${pid}).`);
  try {
    await run(await pgCtl(), ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30'], {
      windowsHide: true,
    });
  } catch (error) {
    // Never kill the pid directly: the system may have handed it to an unrelated program.
    // pg_ctl only signals a real PostgreSQL; when it cannot, starting reports the problem.
    log(`[postgres] Could not stop the previous database: ${String(error)}`);
  }
}

/** The PostgreSQL 17 server bundled with the app. It listens on 127.0.0.1 only. */
export class LocalDatabase implements AdkDatabase {
  private readonly server: EmbeddedPostgres;
  private running = false;

  public constructor(
    private readonly settings: DesktopSettings,
    private readonly dataDir: string,
    private readonly log: (message: string) => void,
  ) {
    this.server = new EmbeddedPostgres({
      databaseDir: dataDir,
      port: settings.databasePort,
      user: USER,
      password: settings.databasePassword,
      authMethod: 'scram-sha-256',
      persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=100'],
      autoRehydrateSymlinks: true,
      onLog: log,
      onError: (message) => log(`[postgres] ${String(message)}`),
    });
  }

  /** Creates the cluster on the first launch, starts it and brings the schema up to date. */
  public async start(migrationsDir: string): Promise<void> {
    if (!existsSync(join(this.dataDir, 'PG_VERSION'))) await this.server.initialise();
    await this.server.start();
    this.running = true;
    await this.createDatabaseIfMissing();
    await this.withClient((client) => applyMigrations(client, migrationsDir));
  }

  /** A connection to the ADK database (or another one of the cluster), closed after `use`. */
  public async withClient<T>(
    use: (client: pg.Client) => Promise<T>,
    database = DATABASE,
  ): Promise<T> {
    const client = new pg.Client({
      host: '127.0.0.1',
      port: this.settings.databasePort,
      user: USER,
      password: this.settings.databasePassword,
      database,
    });
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
    }
  }

  /** Drops the ADK database and creates it empty. The API must be stopped first. */
  public async recreateDatabase(): Promise<void> {
    await this.withClient(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${DATABASE}"`);
    }, 'postgres');
  }

  /**
   * A clean shutdown (pg_ctl stop -m fast): the bundled library kills the server on Windows,
   * which makes every next start replay its log as after a crash.
   */
  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      await run(await pgCtl(), ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '30'], {
        windowsHide: true,
      });
    } catch (error) {
      this.log(`[postgres] Clean stop failed, forcing it: ${String(error)}`);
      await this.server.stop();
    }
  }

  private async createDatabaseIfMissing(): Promise<void> {
    await this.withClient(async (admin) => {
      const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
      if (found.rowCount === 0) await admin.query(`CREATE DATABASE "${DATABASE}"`);
    }, 'postgres');
  }
}

/** What the app needs from the database that holds its data, on this computer or hosted. */
export interface AdkDatabase {
  start(migrationsDir: string): Promise<void>;
  withClient<T>(use: (client: pg.Client) => Promise<T>): Promise<T>;
  /** Leaves the database empty, ready for a restore. The API must be stopped first. */
  recreateDatabase(): Promise<void>;
  stop(): Promise<void>;
}

/** A PostgreSQL hosted elsewhere: nothing to start or stop, only the schema to keep current. */
export class CloudDatabase implements AdkDatabase {
  public constructor(public readonly url: string) {}

  public async start(migrationsDir: string): Promise<void> {
    await this.withClient((client) => applyMigrations(client, migrationsDir));
  }

  public async withClient<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({
      connectionString: this.url,
      connectionTimeoutMillis: 15_000,
      application_name: 'Agent DevKit desktop',
    });
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
    }
  }

  public async recreateDatabase(): Promise<void> {
    await this.withClient((client) => clearCloudDatabase(client));
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }
}
