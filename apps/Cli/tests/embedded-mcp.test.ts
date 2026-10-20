import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Manifest = { dependencies?: Record<string, string> };
const read = (app: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', app, 'package.json'), 'utf8'),
  ) as Manifest;

/** The built MCP server ships inside this package (scripts/embed-mcp.mjs), so its imports resolve here. */
describe('embedded MCP server', () => {
  it('declares every runtime dependency of apps/Mcp with the same range', () => {
    const cli = read('Cli').dependencies ?? {};
    for (const [name, range] of Object.entries(read('Mcp').dependencies ?? {})) {
      expect(cli[name], `add ${name}@${range} to apps/Cli dependencies`).toBe(range);
    }
  });
});
