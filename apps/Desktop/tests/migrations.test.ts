import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, type SqlClient } from '../src/main/migrations.js';

async function migrationsDir(migrations: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adk-migrations-'));
  for (const [name, sql] of Object.entries(migrations)) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'migration.sql'), sql);
  }
  await writeFile(join(dir, 'migration_lock.toml'), 'provider = "postgresql"');
  return dir;
}

function fakeClient(applied: string[], failOn?: string) {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const client: SqlClient = {
    query(text, values) {
      calls.push({ text, values });
      if (text.startsWith('SELECT migration_name')) {
        return Promise.resolve({ rows: applied.map((migration_name) => ({ migration_name })) });
      }
      if (failOn && text === failOn) return Promise.reject(new Error('syntax error'));
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, calls };
}

describe('applyMigrations', () => {
  it('applies the pending migrations in name order and records each one', async () => {
    const dir = await migrationsDir({ '2_second': 'SELECT 2;', '1_first': 'SELECT 1;' });
    const { client, calls } = fakeClient([]);
    expect(await applyMigrations(client, dir)).toEqual(['1_first', '2_second']);
    const sql = calls
      .map((call) => call.text)
      .filter((text) => text.startsWith('SELECT ') && !text.includes('migration_name'));
    expect(sql).toEqual(['SELECT 1;', 'SELECT 2;']);
    const insert = calls.find((call) => call.text.startsWith('INSERT'));
    expect(insert?.values?.[1]).toBe(createHash('sha256').update('SELECT 1;').digest('hex'));
    expect(insert?.values?.[2]).toBe('1_first');
    expect(calls.filter((call) => call.text.includes('finished_at = now()'))).toHaveLength(2);
  });

  it('skips the migrations that were already applied', async () => {
    const dir = await migrationsDir({ '1_first': 'SELECT 1;', '2_second': 'SELECT 2;' });
    const { client } = fakeClient(['1_first']);
    expect(await applyMigrations(client, dir)).toEqual(['2_second']);
  });

  it('logs the error on the migration record and stops when SQL fails', async () => {
    const dir = await migrationsDir({ '1_bad': 'BROKEN;', '2_never': 'SELECT 2;' });
    const { client, calls } = fakeClient([], 'BROKEN;');
    await expect(applyMigrations(client, dir)).rejects.toThrow(
      'Migration 1_bad failed: syntax error',
    );
    expect(calls.some((call) => call.text.includes('SET logs'))).toBe(true);
    expect(calls.some((call) => call.text === 'SELECT 2;')).toBe(false);
  });

  it('reports a non-Error failure by its text', async () => {
    const dir = await migrationsDir({ '1_bad': 'BROKEN;' });
    const client: SqlClient = {
      query: (text) =>
        text === 'BROKEN;'
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            Promise.reject('plain text')
          : Promise.resolve({ rows: [] }),
    };
    await expect(applyMigrations(client, dir)).rejects.toThrow('failed: plain text');
  });
});
