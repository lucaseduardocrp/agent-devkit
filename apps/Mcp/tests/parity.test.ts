import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/registry.js';
import { excludedRoutes, modules } from '../src/modules/index.js';

/**
 * Parity guard: every HTTP route of the ADK backend must be reachable through at least one MCP tool
 * or be explicitly excluded with a reason. Adding a backend route without an MCP tool fails here.
 */
const BACKEND_HTTP = join(import.meta.dirname, '..', '..', 'Backend', 'src', 'adapters', 'http');

export function scanBackendRoutes(directory = BACKEND_HTTP): readonly string[] {
  const routes = new Set<string>();
  const pattern = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(directory, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      routes.add(`${match[1]!.toUpperCase()} ${match[2]!}`);
    }
  }
  return [...routes].sort();
}

describe('backend route parity', () => {
  const registry = new ToolRegistry(modules);
  const covered = new Set(registry.tools.flatMap((tool) => tool.routes));

  it('finds the backend route declarations', () => {
    expect(existsSync(BACKEND_HTTP)).toBe(true);
    expect(scanBackendRoutes().length).toBeGreaterThan(80);
  });

  it('exposes every backend route through a tool or an explicit exclusion', () => {
    const missing = scanBackendRoutes().filter(
      (route) => !covered.has(route) && !(route in excludedRoutes),
    );
    expect(missing, `Add an MCP tool for: ${missing.join(', ')}`).toEqual([]);
  });

  it('only maps tools and exclusions to routes that still exist', () => {
    const backend = new Set(scanBackendRoutes());
    const stale = [...covered, ...Object.keys(excludedRoutes)].filter(
      (route) => !backend.has(route),
    );
    expect(stale, `Stale route mappings: ${stale.join(', ')}`).toEqual([]);
  });

  it('never both covers and excludes a route', () => {
    expect(Object.keys(excludedRoutes).filter((route) => covered.has(route))).toEqual([]);
  });
});
