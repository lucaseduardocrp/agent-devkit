import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_FILES } from '../scripts/sync-development-runner.mjs';

const CLI = join(import.meta.dirname, '..', '..', 'Cli', 'src', 'development');
const VENDOR = join(import.meta.dirname, '..', 'src', 'vendor', 'development');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** The desktop app must execute sessions exactly like `devkit develop` does. */
describe('vendored Development runner', () => {
  it.each(RUNNER_FILES)('%s matches the CLI (run scripts/sync-development-runner.mjs)', (file) => {
    expect(existsSync(join(CLI, file))).toBe(true);
    expect(read(join(VENDOR, file))).toBe(read(join(CLI, file)));
  });
});
