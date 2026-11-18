import type * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  cachePaths,
  cacheStatus,
  clearCache,
  isCacheCategory,
  sizeOf,
  STALE_AFTER_MS,
  type CacheLocations,
} from '../src/main/cache.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('cache cleanup', () => {
  let root = '';
  let locations: CacheLocations;
  const now = Date.now();
  const old = new Date(now - STALE_AFTER_MS - 60_000);

  const file = async (path: string, bytes: number, when?: Date) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x'.repeat(bytes));
    if (when) await utimes(path, when, when);
  };
  const folder = async (path: string, bytes: number, when?: Date) => {
    await file(join(path, 'data.bin'), bytes);
    if (when) await utimes(path, when, when);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adk-cache-test-'));
    locations = {
      userData: join(root, 'userData'),
      tempDir: join(root, 'tmp'),
      workspacesDir: join(root, 'workspaces'),
      browsersDir: join(root, 'userData', 'browsers'),
    };
    await folder(join(locations.userData, 'Cache'), 100);
    await folder(join(locations.userData, 'GPUCache'), 50);
    await file(join(locations.userData, 'settings.json'), 7);
    await folder(join(locations.userData, 'database'), 1000);
    await folder(join(locations.browsersDir, 'chromium-1'), 400);
    await folder(join(locations.tempDir, 'adk-cli-old'), 30, old);
    await folder(join(locations.tempDir, 'e2e-video-old'), 20, old);
    await folder(join(locations.tempDir, 'adk-cli-running'), 999, new Date(now));
    await folder(join(locations.tempDir, 'someone-elses'), 999, old);
    await folder(join(locations.workspacesDir, 'run-old'), 10, old);
    await folder(join(locations.workspacesDir, 'run-running'), 999, new Date(now));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('measures a file, a folder and what is missing', async () => {
    expect(await sizeOf(join(locations.userData, 'settings.json'))).toBe(7);
    expect(await sizeOf(join(locations.userData, 'Cache'))).toBe(100);
    expect(await sizeOf(join(locations.userData, 'nothing'))).toBe(0);
  });

  it('lists only what is safe to delete', async () => {
    const web = await cachePaths(locations, 'web', now);
    expect(web).toContain(join(locations.userData, 'Cache'));
    expect(web.join()).not.toContain('database');
    expect(await cachePaths(locations, 'temp', now)).toEqual(
      expect.arrayContaining([
        join(locations.tempDir, 'adk-cli-old'),
        join(locations.tempDir, 'e2e-video-old'),
        join(locations.workspacesDir, 'run-old'),
      ]),
    );
    expect(await cachePaths(locations, 'temp', now)).toHaveLength(3);
    expect(await cachePaths(locations, 'browser', now)).toEqual([
      join(locations.browsersDir, 'chromium-1'),
    ]);
  });

  it('reports the size of each category', async () => {
    expect(await cacheStatus(locations, now)).toEqual([
      { id: 'web', bytes: 150 },
      { id: 'temp', bytes: 60 },
      { id: 'browser', bytes: 400 },
    ]);
  });

  it('treats folders that do not exist as empty', async () => {
    const nowhere: CacheLocations = {
      userData: join(root, 'a'),
      tempDir: join(root, 'b'),
      workspacesDir: join(root, 'c'),
      browsersDir: join(root, 'd'),
    };
    expect((await cacheStatus(nowhere, now)).map((usage) => usage.bytes)).toEqual([0, 0, 0]);
    expect(await clearCache(nowhere, ['web', 'temp', 'browser'], now)).toEqual({
      freedBytes: 0,
      failed: 0,
    });
  });

  it('deletes the chosen categories and nothing else', async () => {
    const result = await clearCache(locations, ['web', 'temp', 'web'], now);
    expect(result).toEqual({ freedBytes: 210, failed: 0 });
    expect(await exists(join(locations.userData, 'Cache'))).toBe(false);
    expect(await exists(join(locations.tempDir, 'adk-cli-old'))).toBe(false);
    expect(await exists(join(locations.workspacesDir, 'run-old'))).toBe(false);
    // In use, not ours, not selected, or never a cache.
    expect(await exists(join(locations.tempDir, 'adk-cli-running'))).toBe(true);
    expect(await exists(join(locations.tempDir, 'someone-elses'))).toBe(true);
    expect(await exists(join(locations.workspacesDir, 'run-running'))).toBe(true);
    expect(await exists(join(locations.browsersDir, 'chromium-1'))).toBe(true);
    expect(await exists(join(locations.userData, 'database', 'data.bin'))).toBe(true);
    expect(await exists(join(locations.userData, 'settings.json'))).toBe(true);
  });

  it('keeps the browsers folder when it removes the browser', async () => {
    expect(await clearCache(locations, ['browser'], now)).toEqual({ freedBytes: 400, failed: 0 });
    expect(await exists(locations.browsersDir)).toBe(true);
    expect(await exists(join(locations.browsersDir, 'chromium-1'))).toBe(false);
  });

  it('counts what could not be deleted instead of failing', async () => {
    const actual = await vi.importActual<typeof fsp>('node:fs/promises');
    // Something holds a folder open: its removal does nothing (or throws).
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).endsWith('GPUCache')) throw new Error('EBUSY');
      await actual.rm(path, options);
    });
    try {
      const result = await clearCache(locations, ['web'], now);
      expect(result).toEqual({ freedBytes: 100, failed: 1 });
      expect(await exists(join(locations.userData, 'GPUCache'))).toBe(true);
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm);
    }
  });

  it('recognizes the categories', () => {
    expect(isCacheCategory('web')).toBe(true);
    expect(isCacheCategory('database')).toBe(false);
    expect(isCacheCategory(3)).toBe(false);
  });
});
