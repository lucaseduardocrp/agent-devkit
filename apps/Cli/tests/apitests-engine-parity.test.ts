import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_FILES } from '../scripts/sync-apitests-engine.mjs';

const BACKEND = join(
  import.meta.dirname,
  '..',
  '..',
  'Backend',
  'src',
  'modules',
  'apitests',
  'engine',
);
const VENDOR = join(import.meta.dirname, '..', 'src', 'vendor', 'apitests');
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** `devkit runner` must execute API test runs exactly like the ADK workers do. */
describe('vendored API test engine', () => {
  it.each(ENGINE_FILES)('%s matches the backend (run scripts/sync-apitests-engine.mjs)', (file) => {
    expect(existsSync(join(BACKEND, file))).toBe(true);
    expect(read(join(VENDOR, file))).toBe(read(join(BACKEND, file)));
  });
});
