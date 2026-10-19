// Copies the backend's Playwright runner into the CLI, so `devkit runner` executes specs
// exactly like the ADK workers. Run after changing any of these files in apps/Backend;
// tests/e2e-runner-parity.test.ts fails while the copies differ.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_FILES = [
  'domain/e2e-mode.ts',
  'application/access-routing.ts',
  'application/e2e-runner.ts',
  'application/script-guard.ts',
  'adapters/playwright-runner.ts',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'Backend', 'src', 'modules', 'e2e');
const target = join(root, 'src', 'vendor', 'e2e');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of RUNNER_FILES) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(source, file), join(target, file));
    console.log(`synced ${file}`);
  }
}
