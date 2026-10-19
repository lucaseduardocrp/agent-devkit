import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runGuard(testDatabaseUrl?: string) {
  const environment = { ...process.env };
  delete environment.TEST_DATABASE_URL;
  if (testDatabaseUrl !== undefined) {
    environment.TEST_DATABASE_URL = testDatabaseUrl;
  }
  return spawnSync(process.execPath, ['scripts/run-integration-tests.mjs'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
}

describe('integration database guard', () => {
  it('requires the dedicated test variable', () => {
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TEST_DATABASE_URL is required');
  });

  it.each([
    'postgresql://user:password@localhost:5432/adk',
    'mysql://user:password@localhost:3306/adk_test',
    'not-a-url',
  ])('refuses unsafe database target %#', (url) => {
    const result = runGuard(url);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/TEST_DATABASE_URL|integration tests/);
  });
});
