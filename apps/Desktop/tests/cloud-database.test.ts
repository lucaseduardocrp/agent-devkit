import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { restoreBackup, restoreSqlDump, writeBackup } from '../src/main/backup.js';
import {
  clearCloudDatabase,
  describeCloudUrl,
  explainCloudError,
  inspectCloudDatabase,
  openSecret,
  parseCloudUrl,
  sealSecret,
  type SecretCipher,
} from '../src/main/cloud-database.js';
import { applyMigrations } from '../src/main/migrations.js';
import { pickPort } from '../src/main/ports.js';

describe('cloud database URL', () => {
  it('accepts a hosted PostgreSQL URL and describes it without the password', () => {
    const url = parseCloudUrl(
      '  postgresql://ad%40min:s3cret@db.example.com:6543/my%20db?sslmode=require ',
    );
    expect(url).toBe('postgresql://ad%40min:s3cret@db.example.com:6543/my%20db?sslmode=require');
    expect(describeCloudUrl(url)).toEqual({
      host: 'db.example.com',
      port: 6543,
      database: 'my db',
      user: 'ad@min',
    });
    expect(describeCloudUrl('postgres://u:p@host/db').port).toBe(5432);
  });

  it.each([
    ['not a url', /Enter a PostgreSQL connection URL/],
    ['mysql://u:p@host/db', /must start with postgresql/],
    ['postgresql:///db', /no host/],
    ['postgresql://u:p@localhost/db', /on this computer/],
    ['postgresql://u:p@127.0.0.1:5432/db', /on this computer/],
    ['postgresql://host/db', /no user name/],
    ['postgresql://u:p@host', /no database name/],
    ['postgresql://u:p@host/', /no database name/],
  ])('refuses %s', (value, message) => {
    expect(() => parseCloudUrl(value)).toThrow(message);
  });
});

describe('cloud database errors', () => {
  const coded = (code: string, message = 'raw') => Object.assign(new Error(message), { code });

  it.each([
    ['ENOTFOUND', /host was not found/],
    ['EAI_AGAIN', /host was not found/],
    ['ECONNREFUSED', /did not answer/],
    ['ETIMEDOUT', /did not answer/],
    ['28P01', /refused the user or password/],
    ['28000', /refused the user or password/],
    ['3D000', /does not exist/],
    ['42501', /cannot create tables/],
    ['SELF_SIGNED_CERT_IN_CHAIN', /sslmode=no-verify/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /sslmode=no-verify/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /sslmode=no-verify/],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', /sslmode=no-verify/],
  ])('explains %s', (code, message) => {
    expect(explainCloudError(coded(code))).toMatch(message);
  });

  it('explains SSL and timeout messages, and passes anything else through', () => {
    expect(explainCloudError(new Error('The server does not support SSL connections'))).toMatch(
      /sslmode=disable/,
    );
    expect(
      explainCloudError(new Error('connection is insecure (try using sslmode=require)')),
    ).toMatch(/sslmode=require/);
    expect(
      explainCloudError(new Error('no pg_hba.conf entry for host "1.2.3.4", SSL off')),
    ).toMatch(/sslmode=require/);
    expect(explainCloudError(new Error('Connection terminated due to connection timeout'))).toMatch(
      /did not answer in time/,
    );
    expect(explainCloudError(new Error('something else'))).toBe('something else');
    expect(explainCloudError('plain text')).toBe('plain text');
    expect(explainCloudError(null)).toBe('null');
  });
});

describe('sealed secrets', () => {
  const keychain: SecretCipher = {
    available: true,
    encrypt: (text) => Buffer.from(text).toString('base64'),
    decrypt: (sealed) => Buffer.from(sealed, 'base64').toString(),
  };
  const none: SecretCipher = { ...keychain, available: false };

  it('uses the keychain when there is one, and keeps the text when there is not', () => {
    const sealed = sealSecret('postgresql://u:p@h/d', keychain);
    expect(sealed).toMatch(/^safe:/);
    expect(sealed).not.toContain('u:p@h');
    expect(openSecret(sealed, keychain)).toBe('postgresql://u:p@h/d');
    expect(sealSecret('x', none)).toBe('plain:x');
    expect(openSecret('plain:x', none)).toBe('x');
    expect(openSecret('plain:x', keychain)).toBe('x');
  });

  it('cannot open a keychain secret without the keychain, nor an unknown format', () => {
    expect(() => openSecret('safe:abc', none)).toThrow(/cannot be read/);
    expect(() => openSecret('abc', keychain)).toThrow(/cannot be read/);
  });
});

// A real PostgreSQL, used the way a hosted one is: by a user that is not a superuser.
let root: string;
let server: EmbeddedPostgres;
let port: number;
let databases = 0;

async function tenantDatabase(): Promise<pg.Client> {
  const name = `tenant${++databases}`;
  const admin = server.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} OWNER tenant`);
  await admin.end();
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'tenant',
    password: 'tenant',
    database: name,
  });
  await client.connect();
  return client;
}

async function superuserDatabase(): Promise<pg.Client> {
  const name = `owner${++databases}`;
  const admin = server.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const client = server.getPgClient(name, '127.0.0.1');
  await client.connect();
  return client;
}

const SCHEMA = {
  '1_init': `CREATE TYPE "Role" AS ENUM ('ADMIN', 'MEMBER');
  CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "role" "Role" NOT NULL, "manager_id" TEXT REFERENCES "users"("id"));
  CREATE TABLE "notes" ("id" SERIAL PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "body" TEXT NOT NULL);`,
};

async function migrations(): Promise<string> {
  const dir = await mkdtemp(join(root, 'migrations-'));
  for (const [name, sql] of Object.entries(SCHEMA)) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'migration.sql'), sql);
  }
  return dir;
}

const foreignKeys = async (client: pg.Client) =>
  (
    await client.query<{ conname: string; def: string }>(
      "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' ORDER BY conname",
    )
  ).rows;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'adk-cloud-'));
  port = await pickPort(55532, []);
  server = new EmbeddedPostgres({
    databaseDir: join(root, 'data'),
    port,
    user: 'postgres',
    password: 'test',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await server.initialise();
  await server.start();
  const admin = server.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query("CREATE ROLE tenant LOGIN PASSWORD 'tenant'");
  await admin.end();
}, 120_000);

afterAll(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('a hosted database, without superuser rights', () => {
  it('tells an empty database, an ADK one and one of something else apart', async () => {
    const dir = await migrations();
    const client = await tenantDatabase();
    const empty = await inspectCloudDatabase(client, ['1_init']);
    expect(empty).toMatchObject({ kind: 'empty', users: 0, unknownMigrations: [] });
    expect(empty.serverVersion).toMatch(/^\d+/);

    await applyMigrations(client, dir);
    await client.query("INSERT INTO users (id, role) VALUES ('a', 'ADMIN'), ('b', 'MEMBER')");
    expect(await inspectCloudDatabase(client, ['1_init'])).toMatchObject({
      kind: 'adk',
      users: 2,
      unknownMigrations: [],
    });
    // Made by a newer app: it has a migration this one does not know.
    expect((await inspectCloudDatabase(client, [])).unknownMigrations).toEqual(['1_init']);

    await clearCloudDatabase(client);
    expect((await inspectCloudDatabase(client, [])).kind).toBe('empty');
    expect((await client.query("SELECT 1 FROM pg_type WHERE typname = 'Role'")).rowCount).toBe(0);

    await client.query('CREATE TABLE "orders" (id INT)');
    expect((await inspectCloudDatabase(client, [])).kind).toBe('other');
    await client.query('CREATE TABLE "_prisma_migrations" (id INT)');
    expect((await inspectCloudDatabase(client, [])).kind).toBe('other');
    await client.end();
  });

  it('clears composite types and keeps nothing behind', async () => {
    const client = await tenantDatabase();
    await client.query(`CREATE TYPE "pair" AS (a INT, b INT);
      CREATE DOMAIN "positive" AS INT CHECK (VALUE > 0);
      CREATE TABLE "t" (p "pair", n "positive")`);
    await clearCloudDatabase(client);
    const left = await client.query(
      "SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace",
    );
    expect(left.rows).toEqual([]);
    await client.end();
  });

  it('copies data in, rows out of order, and puts the foreign keys back', async () => {
    const dir = await migrations();
    const source = await superuserDatabase();
    await applyMigrations(source, dir);
    // The manager is inserted after the user that points to it, and the note before both.
    await source.query(`SET session_replication_role = replica;
      INSERT INTO notes (user_id, body) VALUES ('z', 'first');
      INSERT INTO users (id, role, manager_id) VALUES ('z', 'MEMBER', 'a');
      INSERT INTO users (id, role) VALUES ('a', 'ADMIN');
      SET session_replication_role = origin;`);
    const file = join(root, 'to-cloud.adkbackup');
    await writeBackup(source, file, 'k'.repeat(64));

    const cloud = await tenantDatabase();
    const before = await superuserDatabase();
    await applyMigrations(before, dir);
    await restoreBackup(cloud, file, dir);
    expect((await cloud.query('SELECT id, manager_id FROM users ORDER BY id')).rows).toEqual([
      { id: 'a', manager_id: null },
      { id: 'z', manager_id: 'a' },
    ]);
    expect(await foreignKeys(cloud)).toEqual(await foreignKeys(before));
    // The serial continues after the copied rows.
    const next = await cloud.query(
      "INSERT INTO notes (user_id, body) VALUES ('a', 'x') RETURNING id",
    );
    expect(next.rows[0].id).toBe(2);
    await expect(
      cloud.query("INSERT INTO notes (user_id, body) VALUES ('missing', 'x')"),
    ).rejects.toThrow(/foreign key/);
    await Promise.all([source.end(), cloud.end(), before.end()]);
  });

  it('refuses rows that break a foreign key, and leaves the database as it was', async () => {
    const dir = await migrations();
    const source = await superuserDatabase();
    await applyMigrations(source, dir);
    await source.query(`SET session_replication_role = replica;
      INSERT INTO notes (user_id, body) VALUES ('ghost', 'orphan');
      SET session_replication_role = origin;`);
    const file = join(root, 'orphan.adkbackup');
    await writeBackup(source, file, 'k'.repeat(64));

    const cloud = await tenantDatabase();
    await expect(restoreBackup(cloud, file, dir)).rejects.toThrow(/foreign key/);
    expect((await cloud.query('SELECT count(*)::int AS n FROM notes')).rows[0].n).toBe(0);
    expect(await foreignKeys(cloud)).toHaveLength(2);
    await Promise.all([source.end(), cloud.end()]);
  });

  it('imports a Docker dump as well', async () => {
    const dir = await migrations();
    const dump = join(root, 'docker.sql');
    await writeFile(
      dump,
      `INSERT INTO public.notes (id, user_id, body) VALUES (1, 'a', 'hi');
INSERT INTO public.users (id, role, manager_id) VALUES ('a', 'ADMIN', NULL);
`,
    );
    const cloud = await tenantDatabase();
    expect(await restoreSqlDump(cloud, dump, dir)).toBe(2);
    expect((await cloud.query('SELECT body FROM notes')).rows).toEqual([{ body: 'hi' }]);
    await cloud.end();
  });
});
