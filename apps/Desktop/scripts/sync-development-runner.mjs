// Copies the Development runner of the CLI (`devkit develop`) into the desktop app, so the app
// executes coding sessions itself, exactly like the CLI does, with no CLI installed. Run after
// changing any of these files in apps/Cli; tests/development-runner-parity.test.ts fails while
// the copies differ.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_FILES = ['agent-clis.ts', 'git.ts', 'process.ts', 'runner.ts'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'Cli', 'src', 'development');
const target = join(root, 'src', 'vendor', 'development');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(target, { recursive: true });
  for (const file of RUNNER_FILES) {
    copyFileSync(join(source, file), join(target, file));
    console.log(`synced ${file}`);
  }
}
