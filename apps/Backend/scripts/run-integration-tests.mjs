import { spawnSync } from 'node:child_process';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  fail('TEST_DATABASE_URL is required; integration tests will not use DATABASE_URL implicitly.');
}

let parsedUrl;
try {
  parsedUrl = new URL(testDatabaseUrl);
} catch {
  fail('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
}

if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
  fail('TEST_DATABASE_URL must use the PostgreSQL protocol.');
}

const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
  fail('Refusing integration tests: the database name must contain a standalone test marker.');
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const environment = { ...process.env, DATABASE_URL: testDatabaseUrl };

run(['prisma', 'migrate', 'deploy']);
run(['prisma', 'migrate', 'deploy']);
run(['vitest', 'run', '--config', 'vitest.integration.config.ts']);

function run(arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    fail(`Integration command could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
