import type { SqlClient } from './migrations.js';

/**
 * A PostgreSQL hosted elsewhere (Neon, Supabase, RDS, Railway…) that holds ADK's data instead of
 * the database on this computer. Everything here works without superuser rights, which hosted
 * providers do not grant.
 */

/** Where the cloud database is, without its password: safe to show and to log. */
export interface CloudTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
}

/** What a database already holds, which decides how the app can start using it. */
export interface CloudInspection {
  /** `empty`: no tables. `adk`: ADK data. `other`: tables of something else (not used). */
  readonly kind: 'empty' | 'adk' | 'other';
  readonly users: number;
  /** Migrations it has that this version of the app does not know (it was made by a newer one). */
  readonly unknownMigrations: readonly string[];
  readonly serverVersion: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Checks a connection URL and returns it trimmed; the error says what to fix. */
export function parseCloudUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      'Enter a PostgreSQL connection URL, such as postgresql://user:password@host/db.',
    );
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('The URL must start with postgresql:// or postgres://.');
  if (!url.hostname) throw new Error('The URL has no host.');
  if (LOOPBACK.has(url.hostname.toLowerCase()))
    throw new Error(
      'This address is on this computer. Use the address of the hosted database instead.',
    );
  if (!url.username) throw new Error('The URL has no user name.');
  if (url.pathname.replace(/^\//, '') === '') throw new Error('The URL has no database name.');
  return text;
}

export function describeCloudUrl(value: string): CloudTarget {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
  };
}

const APPLIED =
  'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL';

export async function inspectCloudDatabase(
  client: SqlClient,
  knownMigrations: readonly string[],
): Promise<CloudInspection> {
  const version = (await client.query('SHOW server_version')).rows[0]?.['server_version'];
  const serverVersion = String(version);
  const tables = new Set(
    (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map(
      (row) => String(row['tablename']),
    ),
  );
  if (tables.size === 0) return { kind: 'empty', users: 0, unknownMigrations: [], serverVersion };
  if (!tables.has('_prisma_migrations') || !tables.has('users'))
    return { kind: 'other', users: 0, unknownMigrations: [], serverVersion };
  const known = new Set(knownMigrations);
  const unknownMigrations = (await client.query(APPLIED)).rows
    .map((row) => String(row['migration_name']))
    .filter((name) => !known.has(name))
    .sort();
  const count = (await client.query('SELECT count(*)::int AS n FROM "users"')).rows[0]?.['n'];
  return { kind: 'adk', users: Number(count), unknownMigrations, serverVersion };
}

/**
 * Empties the database for a restore: drops every table and type of the public schema. The
 * database itself cannot be dropped and created again on a hosted server.
 */
export async function clearCloudDatabase(client: SqlClient): Promise<void> {
  await client.query(`DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', item.tablename);
  END LOOP;
  FOR item IN
    SELECT t.typname FROM pg_type t
    WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd', 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', item.typname);
  END LOOP;
END $$`);
}

/** Turns a connection failure into what the user can do about it. */
export function explainCloudError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The host was not found. Check the address and your internet connection.';
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return 'The server did not answer. Check the host and port, and that it accepts connections from your network.';
    case '28P01':
    case '28000':
      return 'The server refused the user or password.';
    case '3D000':
      return 'That database does not exist on the server. Create it first.';
    case '42501':
      return 'The user cannot create tables in this database. Grant it CREATE on the public schema, or use the database owner.';
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return 'The server certificate could not be verified. If you trust this provider, add ?sslmode=no-verify to the URL (the connection stays encrypted).';
    default:
      if (/does not support SSL/i.test(message))
        return 'The server does not accept encrypted connections. Add ?sslmode=disable to the URL only if it is on a network you trust.';
      if (/insecure|SSL off|no pg_hba\.conf entry/i.test(message))
        return 'The server requires an encrypted connection. Add ?sslmode=require to the URL.';
      if (/timeout/i.test(message))
        return 'The server did not answer in time. Check the host and port, and that it accepts connections from your network.';
      return message;
  }
}

/** Seals a secret for the settings file; on systems without a keychain it is kept as is. */
export interface SecretCipher {
  readonly available: boolean;
  encrypt(text: string): string;
  decrypt(sealed: string): string;
}

export function sealSecret(text: string, cipher: SecretCipher): string {
  return cipher.available ? `safe:${cipher.encrypt(text)}` : `plain:${text}`;
}

export function openSecret(sealed: string, cipher: SecretCipher): string {
  if (sealed.startsWith('plain:')) return sealed.slice('plain:'.length);
  if (sealed.startsWith('safe:') && cipher.available)
    return cipher.decrypt(sealed.slice('safe:'.length));
  throw new Error('The saved cloud database address cannot be read on this computer.');
}
