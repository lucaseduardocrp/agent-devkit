import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SOURCE, TARGET } from '../scripts/sync-cli-specs.mjs';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** The Bridge must run a CLI for a workspace exactly like the API does on its own machine. */
describe('vendored CLI specs', () => {
  it('match the backend (run scripts/sync-cli-specs.mjs)', () => {
    expect(existsSync(SOURCE)).toBe(true);
    expect(read(TARGET)).toBe(read(SOURCE));
  });
});
