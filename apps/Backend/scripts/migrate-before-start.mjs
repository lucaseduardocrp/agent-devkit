import { spawnSync } from 'node:child_process';
if (process.env.DATABASE_PROVIDER === 'postgres') {
  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (result.error || result.status !== 0) {
    console.error('Database migration failed; backend startup was stopped.');
    process.exit(1);
  }
}
