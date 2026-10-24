// Copies the backend's API test engine into the CLI, so `devkit runner` executes integration and
// load runs exactly like the ADK workers. Run after changing any of these files in apps/Backend;
// tests/apitests-engine-parity.test.ts fails while the copies differ.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_FILES = [
  'types.ts',
  'http-request.ts',
  'collection-runner.ts',
  'load-profiles.ts',
  'load-runner.ts',
  'run-executor.ts',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'Backend', 'src', 'modules', 'apitests', 'engine');
const target = join(root, 'src', 'vendor', 'apitests');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(target, { recursive: true });
  for (const file of ENGINE_FILES) {
    copyFileSync(join(source, file), join(target, file));
    console.log(`synced ${file}`);
  }
}
