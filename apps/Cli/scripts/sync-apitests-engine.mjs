// Copies the backend's API test engine into the CLI, so `devkit runner` executes integration and
// load runs exactly like the ADK workers. Run after changing any file of the engine folder in
// apps/Backend; tests/apitests-engine-parity.test.ts fails while the copies differ.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'Backend', 'src', 'modules', 'apitests', 'engine');
const target = join(root, 'src', 'vendor', 'apitests');

/** Every TypeScript file of the engine folder: the engine is self-contained by design. */
export const ENGINE_FILES = readdirSync(source)
  .filter((file) => file.endsWith('.ts'))
  .sort();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(target, { recursive: true });
  // Files the engine no longer has would otherwise linger in the CLI.
  for (const file of readdirSync(target)) {
    if (file.endsWith('.ts') && !ENGINE_FILES.includes(file)) {
      rmSync(join(target, file));
      console.log(`removed ${file}`);
    }
  }
  for (const file of ENGINE_FILES) {
    copyFileSync(join(source, file), join(target, file));
    console.log(`synced ${file}`);
  }
}
