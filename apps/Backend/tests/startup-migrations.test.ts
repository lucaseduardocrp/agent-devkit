import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('local startup migrations', () => {
  it('preserves startup without a database in memory mode', () => {
    const env = { ...process.env };
    delete env.DATABASE_PROVIDER;
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, ['scripts/migrate-before-start.mjs'], {
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('stops startup if the configured PostgreSQL migration cannot run', () => {
    const result = spawnSync(process.execPath, ['scripts/migrate-before-start.mjs'], {
      env: { ...process.env, DATABASE_PROVIDER: 'postgres', DATABASE_URL: 'invalid-url' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Database migration failed; backend startup was stopped.');
  }, 30_000);
});
