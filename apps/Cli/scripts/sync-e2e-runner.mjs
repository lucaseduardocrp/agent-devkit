// Copies the backend's Playwright runner into the CLI, so `devkit runner` executes specs
// exactly like the ADK workers. Run after changing any of these files in apps/Backend;
// tests/e2e-runner-parity.test.ts fails while the copies differ. The copies keep the backend's
// layout under src/vendor/backend (paths relative to apps/Backend/src), so relative imports between
// them resolve unchanged.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_FILES = [
  'modules/e2e/domain/e2e-mode.ts',
  'modules/e2e/application/access-routing.ts',
  'modules/e2e/application/e2e-runner.ts',
  'modules/e2e/application/script-guard.ts',
  'modules/e2e/adapters/playwright-runner.ts',
  'shared/host-access.ts',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'Backend', 'src');
const target = join(root, 'src', 'vendor', 'backend');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of RUNNER_FILES) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(source, file), join(target, file));
    console.log(`synced ${file}`);
  }
}
