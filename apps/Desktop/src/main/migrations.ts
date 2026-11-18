import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The part of a pg client the migrator uses, so tests can fake it. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

/**
 * Applies the Prisma migrations that are still pending, recording them in `_prisma_migrations`
 * as `prisma migrate deploy` does (same table, same SHA-256 checksum), so the app does not need
 * to ship the Prisma CLI and its engines. With `only`, applies just those (a backup restored up to
 * the version that made it). Returns the names it applied.
 */
export async function applyMigrations(
  client: SqlClient,
  directory: string,
  only?: ReadonlySet<string>,
): Promise<string[]> {
  await client.query(TABLE);
  const done = await client.query(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  const applied = new Set(done.rows.map((row) => String(row['migration_name'])));
  const names = await migrationNames(directory);
  const newlyApplied: string[] = [];
  for (const name of names) {
    if (applied.has(name) || (only && !only.has(name))) continue;
    const sql = await readFile(join(directory, name, 'migration.sql'), 'utf8');
    const id = randomUUID();
    const checksum = createHash('sha256').update(sql).digest('hex');
    await client.query(
      'INSERT INTO "_prisma_migrations" (id, checksum, migration_name) VALUES ($1, $2, $3)',
      [id, checksum, name],
    );
    try {
      await client.query(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query('UPDATE "_prisma_migrations" SET logs = $2 WHERE id = $1', [id, message]);
      throw new Error(`Migration ${name} failed: ${message}`, { cause: error });
    }
    await client.query(
      'UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1',
      [id],
    );
    newlyApplied.push(name);
  }
  return newlyApplied;
}

/** The migrations shipped with this version of the app, in the order they apply. */
export async function migrationNames(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
