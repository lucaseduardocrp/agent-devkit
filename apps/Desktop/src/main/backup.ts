import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  SqlStatementSplitter,
  classifyDumpStatement,
  insertStatement,
  isBackupHeader,
  isGzip,
  quoteIdentifier,
  type BackupHeader,
  type BackupLine,
} from './backup-format.js';
import { applyMigrations, migrationNames, type SqlClient } from './migrations.js';

const FETCH_ROWS = 500;
/** Rows are sent in INSERTs of up to this many characters (large videos go one by one). */
const BATCH_CHARS = 4 * 1024 * 1024;

const APPLIED_MIGRATIONS =
  'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name';

/** A pg client: plain queries, plus row arrays for the cursor reads. */
export interface BackupSource extends SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  query(config: { text: string; rowMode: 'array' }): Promise<{ rows: unknown[][] }>;
}

export interface BackupSummary {
  readonly tables: number;
  readonly rows: number;
}

/**
 * Writes every row of the public schema to `file`, from one consistent snapshot, so the app can
 * keep running while it is made. The schema itself is not saved: it is rebuilt from the
 * migrations listed in the header.
 */
export async function writeBackup(
  client: BackupSource,
  file: string,
  integrationEncryptionKey: string,
): Promise<BackupSummary> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const summary = { tables: 0, rows: 0 };
  try {
    const migrations = (await client.query(APPLIED_MIGRATIONS)).rows.map((row) =>
      String(row['migration_name']),
    );
    const tables = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename",
      )
    ).rows.map((row) => String(row['tablename']));
    const header: BackupHeader = {
      format: 'adk-desktop-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      migrations,
      integrationEncryptionKey,
    };
    async function* lines(): AsyncGenerator<string> {
      yield `${JSON.stringify(header)}\n`;
      for (const table of tables) {
        const columns = (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position",
            [table],
          )
        ).rows.map((row) => String(row['column_name']));
        yield `${JSON.stringify({ table, columns } satisfies BackupLine)}\n`;
        summary.tables++;
        const select = columns.map((column) => `${quoteIdentifier(column)}::text`).join(', ');
        await client.query(
          `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT ${select} FROM ${quoteIdentifier(table)}`,
        );
        for (;;) {
          const { rows } = await client.query({
            text: `FETCH ${FETCH_ROWS} FROM backup_rows`,
            rowMode: 'array',
          });
          for (const record of rows) {
            const row = record as (string | null)[];
            yield `${JSON.stringify({ row } satisfies BackupLine)}\n`;
            summary.rows++;
          }
          if (rows.length < FETCH_ROWS) break;
        }
        await client.query('CLOSE backup_rows');
      }
    }
    await pipeline(Readable.from(lines()), createGzip(), createWriteStream(file));
  } finally {
    await client.query('COMMIT');
  }
  return summary;
}

export type BackupKind = 'backup' | 'sql';

/** A desktop backup is gzip-compressed; anything else is taken for a pg_dump SQL file. */
export async function backupKind(file: string): Promise<BackupKind> {
  const handle = await open(file, 'r');
  try {
    const start = new Uint8Array(2);
    await handle.read(start, 0, 2, 0);
    return isGzip(start) ? 'backup' : 'sql';
  } finally {
    await handle.close();
  }
}

/** Reads the header of a desktop backup without loading the rest. */
export async function readBackupHeader(file: string): Promise<BackupHeader> {
  for await (const line of backupLines(file)) {
    const parsed: unknown = JSON.parse(line);
    if (!isBackupHeader(parsed)) break;
    return parsed;
  }
  throw new Error('This file is not an Agent DevKit backup.');
}

async function* backupLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file).pipe(createGunzip());
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) if (line) yield line;
  } finally {
    reader.close();
    input.destroy();
  }
}

/**
 * Fills an empty database from a desktop backup: the migrations the backup was made with first,
 * then its rows (foreign keys and triggers are paused while they load), then the newer migrations
 * of this app, so data migrations also run on the restored rows.
 */
export async function restoreBackup(
  client: SqlClient,
  file: string,
  migrationsDir: string,
): Promise<BackupHeader> {
  const header = await readBackupHeader(file);
  const known = new Set(await migrationNames(migrationsDir));
  const unknown = header.migrations.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `The backup was made by a newer version of Agent DevKit (${unknown[0]}). Update the app and try again.`,
    );
  }
  await applyMigrations(client, migrationsDir, new Set(header.migrations));
  await client.query('BEGIN');
  try {
    const restoreKeys = await pauseForeignKeys(client);
    let table = '';
    let columns: readonly string[] = [];
    let batch: (readonly (string | null)[])[] = [];
    let batchChars = 0;
    const flush = async () => {
      if (batch.length > 0) await client.query(insertStatement(table, columns, batch));
      batch = [];
      batchChars = 0;
    };
    let first = true;
    for await (const text of backupLines(file)) {
      if (first) {
        first = false;
        continue;
      }
      const line = JSON.parse(text) as BackupLine;
      if ('table' in line) {
        await flush();
        table = line.table;
        columns = line.columns;
        continue;
      }
      batch.push(line.row);
      batchChars += line.row.reduce((total, value) => total + (value?.length ?? 4), 0);
      if (batchChars >= BATCH_CHARS) await flush();
    }
    await flush();
    await restoreKeys();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await resetSequences(client);
  await applyMigrations(client, migrationsDir);
  return header;
}

/**
 * Fills an empty database from a data-only SQL dump of the Docker install. The schema comes
 * from this app's migrations, so both must be on the same ADK version. Only inserts, settings and
 * sequence positions run; any other statement stops the import.
 */
export async function restoreSqlDump(
  client: SqlClient,
  file: string,
  migrationsDir: string,
): Promise<number> {
  await applyMigrations(client, migrationsDir);
  let inserts = 0;
  await client.query('BEGIN');
  try {
    const restoreKeys = await pauseForeignKeys(client);
    const splitter = new SqlStatementSplitter();
    const run = async (statements: string[]) => {
      for (const statement of statements) {
        const verdict = classifyDumpStatement(statement);
        if (verdict === 'refuse') {
          throw new Error(
            `The file has a statement a data dump does not contain, so it was not imported: ${statement.slice(0, 80)}`,
          );
        }
        if (verdict === 'skip') continue;
        // A dump may turn off foreign keys itself; the transaction keeps them off already.
        if (/^SET\s+session_replication_role/i.test(statement)) continue;
        await client.query(statement);
        if (/^INSERT/i.test(statement)) inserts++;
      }
    };
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      await run(splitter.push(chunk as string));
    }
    await run(splitter.end());
    await client.query('SET search_path TO public');
    await restoreKeys();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await resetSequences(client);
  return inserts;
}

/**
 * Inside a transaction, lets rows load in any order. A superuser turns the foreign keys off for the
 * transaction; a hosted PostgreSQL grants no superuser, so the keys are dropped instead and the
 * returned function adds them back, which checks every row loaded. Both undo themselves on a
 * rollback.
 */
async function pauseForeignKeys(client: SqlClient): Promise<() => Promise<void>> {
  await client.query('SAVEPOINT pause_foreign_keys');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('RELEASE SAVEPOINT pause_foreign_keys');
    return () => Promise.resolve();
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT pause_foreign_keys');
  }
  const keys = (
    await client.query(
      `SELECT format('%I.%I', n.nspname, t.relname) AS "table", quote_ident(c.conname) AS name,
              pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'
       ORDER BY 1, 2`,
    )
  ).rows.map((row) => ({
    table: String(row['table']),
    name: String(row['name']),
    definition: String(row['definition']),
  }));
  for (const key of keys)
    await client.query(`ALTER TABLE ${key.table} DROP CONSTRAINT ${key.name}`);
  return async () => {
    for (const key of keys)
      await client.query(`ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name} ${key.definition}`);
  };
}

/** Moves every serial sequence past the highest value restored into its column. */
async function resetSequences(client: SqlClient): Promise<void> {
  await client.query(`DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT c.table_name, c.column_name, pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval(%'
  LOOP
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT max(%I) FROM public.%I), 0) + 1, false)',
      item.seq, item.column_name, item.table_name
    );
  END LOOP;
END $$`);
}
