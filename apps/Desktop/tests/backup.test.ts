import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {
  backupKind,
  readBackupHeader,
  restoreBackup,
  restoreSqlDump,
  writeBackup,
} from '../src/main/backup.js';
import { applyMigrations } from '../src/main/migrations.js';
import { pickPort } from '../src/main/ports.js';

// A real PostgreSQL from the same bundled binaries the app ships.
let root: string;
let server: EmbeddedPostgres;
let port: number;
let databases = 0;

const MIGRATIONS = {
  '1_init': `CREATE TABLE "items" (
    "id" TEXT PRIMARY KEY,
    "position" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB,
    "tags" TEXT[],
    "blob" BYTEA,
    "at" TIMESTAMPTZ
  );
  CREATE TABLE "notes" (
    "id" TEXT PRIMARY KEY,
    "item_id" TEXT NOT NULL REFERENCES "items"("id"),
    "body" TEXT NOT NULL
  );`,
  // A data migration: it must also run on rows restored from an older backup.
  '2_upper': `ALTER TABLE "items" ADD COLUMN "label" TEXT;
  UPDATE "items" SET "label" = upper("name");`,
};

async function migrationsDir(names: readonly (keyof typeof MIGRATIONS)[]): Promise<string> {
  const dir = await mkdtemp(join(root, 'migrations-'));
  for (const name of names) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'migration.sql'), MIGRATIONS[name]);
  }
  return dir;
}

async function newDatabase(): Promise<pg.Client> {
  const name = `db${++databases}`;
  const admin = server.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'adk',
    password: 'test',
    database: name,
  });
  await client.connect();
  return client;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'adk-backup-'));
  port = await pickPort(55432, []);
  server = new EmbeddedPostgres({
    databaseDir: join(root, 'data'),
    port,
    user: 'adk',
    password: 'test',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
}, 120_000);

afterAll(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

const tricky = "it's a \\ backslash; with\nnew lines -- and 'quotes'";

async function seed(client: pg.Client, dir: string) {
  await applyMigrations(client, dir);
  await client.query(
    `INSERT INTO items (id, name, data, tags, blob, at) VALUES
     ('a', $1, '{"k": [1, "two"]}', ARRAY['x', 'y,z', NULL], '\\x00ff10'::bytea, '2026-11-10T10:00:00Z'),
     ('b', 'plain', NULL, NULL, NULL, NULL)`,
    [tricky],
  );
  // A note inserted before its item would break a foreign key if the restore checked it.
  await client.query(`INSERT INTO notes (id, item_id, body) VALUES ('n1', 'a', 'hello')`);
}

const snapshot = async (client: pg.Client) => ({
  items: (
    await client.query(
      "SELECT id, position, name, data, tags, encode(blob, 'hex') AS blob, at FROM items ORDER BY id",
    )
  ).rows,
  notes: (await client.query('SELECT * FROM notes ORDER BY id')).rows,
});

describe('desktop backups', () => {
  it('restores exactly what was backed up, and serials continue after it', async () => {
    const dir = await migrationsDir(['1_init', '2_upper']);
    const source = await newDatabase();
    await seed(source, dir);
    const file = join(root, 'full.adkbackup');
    expect(await writeBackup(source, file, 'secret-key')).toEqual({ tables: 2, rows: 3 });
    expect(await backupKind(file)).toBe('backup');
    expect((await readBackupHeader(file)).migrations).toEqual(['1_init', '2_upper']);

    const target = await newDatabase();
    const header = await restoreBackup(target, file, dir);
    expect(header.integrationEncryptionKey).toBe('secret-key');
    expect(await snapshot(target)).toEqual(await snapshot(source));
    const next = await target.query(
      "INSERT INTO items (id, name) VALUES ('c', 'c') RETURNING position",
    );
    expect(next.rows[0].position).toBe(3);
    await source.end();
    await target.end();
  });

  it('restores an older backup up to its version, then runs the newer migrations', async () => {
    const source = await newDatabase();
    await seed(source, await migrationsDir(['1_init']));
    const file = join(root, 'old.adkbackup');
    await writeBackup(source, file, 'k');

    const target = await newDatabase();
    await restoreBackup(target, file, await migrationsDir(['1_init', '2_upper']));
    const labels = await target.query('SELECT label FROM items ORDER BY id');
    expect(labels.rows.map((row: { label: string }) => row.label)).toEqual([
      tricky.toUpperCase(),
      'PLAIN',
    ]);
    await source.end();
    await target.end();
  });

  it('sends rows larger than a batch on their own', async () => {
    const dir = await migrationsDir(['1_init']);
    const source = await newDatabase();
    await applyMigrations(source, dir);
    const big = 'v'.repeat(5 * 1024 * 1024);
    await source.query("INSERT INTO items (id, name) VALUES ('big', $1), ('small', 's')", [big]);
    const file = join(root, 'big.adkbackup');
    await writeBackup(source, file, 'k');
    const target = await newDatabase();
    await restoreBackup(target, file, dir);
    const rows = await target.query('SELECT id, length(name) AS size FROM items ORDER BY id');
    expect(rows.rows).toEqual([
      { id: 'big', size: big.length },
      { id: 'small', size: 1 },
    ]);
    await source.end();
    await target.end();
  });

  it('refuses a backup made by a newer version of the app', async () => {
    const source = await newDatabase();
    await seed(source, await migrationsDir(['1_init', '2_upper']));
    const file = join(root, 'new.adkbackup');
    await writeBackup(source, file, 'k');
    const target = await newDatabase();
    await expect(restoreBackup(target, file, await migrationsDir(['1_init']))).rejects.toThrow(
      'newer version of Agent DevKit (2_upper)',
    );
    await source.end();
    await target.end();
  });

  it('leaves the database untouched when a row cannot be restored', async () => {
    const dir = await migrationsDir(['1_init']);
    const source = await newDatabase();
    await seed(source, dir);
    const file = join(root, 'dup.adkbackup');
    await writeBackup(source, file, 'k');
    const target = await newDatabase();
    await applyMigrations(target, dir);
    await target.query("INSERT INTO items (id, name) VALUES ('a', 'already here')");
    await expect(restoreBackup(target, file, dir)).rejects.toThrow(/duplicate key/);
    expect((await target.query('SELECT count(*)::int AS n FROM items')).rows[0].n).toBe(1);
    await source.end();
    await target.end();
  });

  it('refuses a file that is not a backup', async () => {
    const file = join(root, 'other.gz');
    const { gzipSync } = await import('node:zlib');
    await writeFile(file, gzipSync('{"format":"something-else"}\n'));
    await expect(readBackupHeader(file)).rejects.toThrow('not an Agent DevKit backup');
    const empty = join(root, 'empty.gz');
    await writeFile(empty, gzipSync(''));
    await expect(readBackupHeader(empty)).rejects.toThrow('not an Agent DevKit backup');
  });
});

describe('Docker SQL dumps', () => {
  // What `pg_dump --data-only --column-inserts --rows-per-insert` writes, trimmed. Since 17.6 it
  // also wraps the dump in \restrict / \unrestrict psql meta-commands.
  const dump = `--
-- PostgreSQL database dump
--

\\restrict Dq6m0rKcGhaIQ1Xk

--
--
SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET session_replication_role = replica;

INSERT INTO public.notes (id, item_id, body) VALUES
\t('n1', 'a', 'note; with -- dashes');
INSERT INTO public.items (id, "position", name, data, tags, blob, at) VALUES
\t('a', 7, '${tricky.replaceAll("'", "''")}', '{"k": 1}', '{x,"y,z"}', '\\x00ff', '2026-11-10 10:00:00+00');
INSERT INTO public._prisma_migrations (id, checksum, migration_name) VALUES ('x', 'y', 'z');

SELECT pg_catalog.setval('public.items_position_seq', 7, true);

--
-- PostgreSQL database dump complete
--

\\unrestrict Dq6m0rKcGhaIQ1Xk
`;

  it('imports the rows into a schema built from the migrations', async () => {
    const dir = await migrationsDir(['1_init', '2_upper']);
    const file = join(root, 'docker.sql');
    await writeFile(file, dump);
    expect(await backupKind(file)).toBe('sql');
    const target = await newDatabase();
    expect(await restoreSqlDump(target, file, dir)).toBe(2);
    const item = (await target.query('SELECT name, position, tags FROM items')).rows[0];
    expect(item).toEqual({ name: tricky, position: 7, tags: ['x', 'y,z'] });
    const next = await target.query(
      "INSERT INTO items (id, name) VALUES ('c', 'c') RETURNING position",
    );
    expect(next.rows[0].position).toBe(8);
    await target.end();
  });

  it('refuses a file with statements a data dump does not have, importing nothing', async () => {
    const dir = await migrationsDir(['1_init']);
    const file = join(root, 'evil.sql');
    await writeFile(
      file,
      "INSERT INTO public.items (id, name) VALUES ('a', 'a');\nDROP TABLE public.notes;\n",
    );
    const target = await newDatabase();
    await expect(restoreSqlDump(target, file, dir)).rejects.toThrow('DROP TABLE public.notes');
    expect((await target.query('SELECT count(*)::int AS n FROM items')).rows[0].n).toBe(0);
    await target.end();
  });

  it('imports a dump whose last statement has no semicolon', async () => {
    const file = join(root, 'tail.sql');
    await writeFile(file, "INSERT INTO public.items (id, name) VALUES ('t', 'tail')");
    const target = await newDatabase();
    expect(await restoreSqlDump(target, file, await migrationsDir(['1_init']))).toBe(1);
    await target.end();
  });
});
