import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_FILES } from '../scripts/sync-e2e-runner.mjs';

const BACKEND = join(import.meta.dirname, '..', '..', 'Backend', 'src');
const VENDOR = join(import.meta.dirname, '..', 'src', 'vendor', 'backend');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** The local runner must execute specs exactly like the ADK workers do. */
describe('vendored E2E runner', () => {
  it.each(RUNNER_FILES)('%s matches the backend (run scripts/sync-e2e-runner.mjs)', (file) => {
    expect(existsSync(join(BACKEND, file))).toBe(true);
    expect(read(join(VENDOR, file))).toBe(read(join(BACKEND, file)));
  });
});
