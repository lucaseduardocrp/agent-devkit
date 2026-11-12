import type * as Fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { packageVersion } from '../src/bootstrap/create-server.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe('packageVersion', () => {
  it('reads the version of the package manifest', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('falls back to 0.0.0 when the manifest has no version', () => {
    vi.mocked(readFileSync).mockReturnValueOnce('{"name":"adk"}');
    expect(packageVersion()).toBe('0.0.0');
  });
});
