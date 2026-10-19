import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// A local npm start must serve the current TypeScript source. Runtime images
// contain only dist, so they skip this step and keep their immutable build.
if (existsSync('src/bootstrap/server.ts')) {
  const result = spawnSync('npm run build', { shell: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
