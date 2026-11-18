import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What the app leaves on this computer that can be deleted without losing data:
 *  - `web`: the web view's caches (pages, compiled code, graphics shaders); rebuilt as needed;
 *  - `temp`: folders of runs that did not clean up after themselves (a crash, a forced quit);
 *  - `browser`: the browser E2E tests drive; it is downloaded again from the ADK menu.
 * The database, backups and settings are never touched.
 */
export const CACHE_CATEGORIES = ['web', 'temp', 'browser'] as const;
export type CacheCategory = (typeof CACHE_CATEGORIES)[number];

export interface CacheLocations {
  readonly userData: string;
  readonly tempDir: string;
  /** Where the API keeps the folder of each E2E run while it executes. */
  readonly workspacesDir: string;
  readonly browsersDir: string;
}

export interface CacheUsage {
  readonly id: CacheCategory;
  readonly bytes: number;
}

export interface CacheCleared {
  readonly freedBytes: number;
  /** Items still in place, usually because something is using them. */
  readonly failed: number;
}

const WEB_FOLDERS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
];
const TEMP_PREFIXES = ['adk-cli-', 'adk-explore-', 'e2e-video-'];
const RUN_PREFIX = 'run-';
/** A folder this recent may belong to a run that is still going. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

const entries = (folder: string): Promise<string[]> => readdir(folder).catch(() => []);

async function staleChildren(
  folder: string,
  prefixes: readonly string[],
  now: number,
): Promise<string[]> {
  const found: string[] = [];
  for (const name of await entries(folder)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(folder, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs >= STALE_AFTER_MS) found.push(path);
  }
  return found;
}

/** The files and folders a category stands for right now. */
export async function cachePaths(
  locations: CacheLocations,
  id: CacheCategory,
  now = Date.now(),
): Promise<string[]> {
  switch (id) {
    case 'web':
      return WEB_FOLDERS.map((name) => join(locations.userData, name));
    case 'temp':
      return [
        ...(await staleChildren(locations.tempDir, TEMP_PREFIXES, now)),
        ...(await staleChildren(locations.workspacesDir, [RUN_PREFIX], now)),
      ];
    case 'browser':
      return (await entries(locations.browsersDir)).map((name) =>
        join(locations.browsersDir, name),
      );
  }
}

/** Bytes of a file, or of everything inside a folder; 0 when it is not there. */
export async function sizeOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await entries(path)) total += await sizeOf(join(path, name));
  return total;
}

async function usageOf(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += await sizeOf(path);
  return total;
}

export async function cacheStatus(
  locations: CacheLocations,
  now = Date.now(),
): Promise<CacheUsage[]> {
  const usage: CacheUsage[] = [];
  for (const id of CACHE_CATEGORIES) {
    usage.push({ id, bytes: await usageOf(await cachePaths(locations, id, now)) });
  }
  return usage;
}

/** Deletes the chosen categories; what cannot be deleted (in use) is counted, not fatal. */
export async function clearCache(
  locations: CacheLocations,
  ids: readonly CacheCategory[],
  now = Date.now(),
): Promise<CacheCleared> {
  let freedBytes = 0;
  let failed = 0;
  for (const id of new Set(ids)) {
    for (const path of await cachePaths(locations, id, now)) {
      const before = await sizeOf(path);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      const left = await sizeOf(path);
      freedBytes += before - left;
      if (left > 0) failed += 1;
    }
  }
  return { freedBytes, failed };
}

export const isCacheCategory = (value: unknown): value is CacheCategory =>
  typeof value === 'string' && (CACHE_CATEGORIES as readonly string[]).includes(value);
