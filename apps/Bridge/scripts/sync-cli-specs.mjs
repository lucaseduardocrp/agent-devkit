// Copies the backend's description of the AI CLIs (what each one is asked, and how its output is
// read) into the Bridge, so the Bridge runs a CLI for a workspace exactly like the API does on its
// own machine. Run after changing apps/Backend/.../cli-llm/cli-specs.ts;
// tests/cli-specs-parity.test.ts fails while the copy differs.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE = join(
  root,
  '..',
  'Backend',
  'src',
  'modules',
  'agents',
  'adapters',
  'cli-llm',
  'cli-specs.ts',
);
export const TARGET = join(root, 'src', 'vendor', 'cli-specs.ts');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(TARGET), { recursive: true });
  copyFileSync(SOURCE, TARGET);
  console.log('synced cli-specs.ts');
}
