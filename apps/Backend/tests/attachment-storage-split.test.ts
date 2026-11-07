import { describe, expect, it, vi } from 'vitest';
import {
  createAttachmentStore,
  createE2eArtifactStore,
} from '../src/modules/e2e/adapters/artifact-store-factory.js';
import { PrismaE2eArtifactStore } from '../src/modules/e2e/adapters/prisma-e2e-artifact-store.js';
import {
  FileSystemE2eArtifactStore,
  InMemoryE2eArtifactStore,
  type E2eArtifactStore,
} from '../src/modules/e2e/application/artifact-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { migrateAttachments } from '../src/modules/shared/attachment-migration.js';
import { LegacyFallbackArtifactStore } from '../src/modules/shared/legacy-fallback-store.js';

const BUCKET = 'https://acct.r2.cloudflarestorage.com/the-bucket';
const OTHER_BUCKET = 'https://acct.r2.cloudflarestorage.com/attachments-bucket';
const KEYS = { E2E_R2_ACCESS_KEY_ID: 'id', E2E_R2_SECRET_ACCESS_KEY: 'secret' };
const urls = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.map((call) => (call[0] as Request).url);

describe('createAttachmentStore', () => {
  const e2e = (env: NodeJS.ProcessEnv) => createE2eArtifactStore(env, {} as PrismaClient);

  it('keeps writing next to the videos when nothing separates them', () => {
    const base = e2e({});
    expect(createAttachmentStore({}, base)).toBe(base);
    // A folder on disk only applies when the E2E storage is also on disk.
    expect(createAttachmentStore({ ATTACHMENTS_DIR: 'files' }, base)).toBe(base);
  });

  it('can keep attachments in their own local folder', () => {
    const disk = createE2eArtifactStore({});
    const split = createAttachmentStore({ ATTACHMENTS_DIR: ' files ' }, disk);
    expect(split.kind).toBe('filesystem');
    expect(split.store).toBeInstanceOf(FileSystemE2eArtifactStore);
    expect(split.store).not.toBe(disk.store);
    expect(createAttachmentStore({}, disk)).toBe(disk);
  });

  it('puts attachments at the root of the bucket and finds the old ones in the E2E folder', async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response('', { status: (input as Request).method === 'PUT' ? 200 : 404 }),
      ),
    );
    const env = { E2E_R2_URL: BUCKET, ...KEYS };
    const result = createAttachmentStore(env, e2e(env), fetcher);
    expect(result.kind).toBe('r2');
    expect(result.split).toBeDefined();

    await result.store.put('attachments/ws/1/content', Buffer.from('x'));
    expect(urls(fetcher)[0]).toBe(`${BUCKET}/attachments/ws/1/content`);

    // Not found at the new place: the old place is tried.
    await result.store.get('attachments/ws/1/content');
    expect(urls(fetcher).slice(1)).toEqual([
      `${BUCKET}/attachments/ws/1/content`,
      `${BUCKET}/e2e/attachments/ws/1/content`,
    ]);
  });

  it('treats the same bucket named explicitly as the shared one', () => {
    const env = { E2E_R2_URL: BUCKET, ATTACHMENTS_R2_URL: BUCKET, ...KEYS };
    expect(createAttachmentStore(env, e2e(env)).split).toBeDefined();
  });

  it('uses its own prefix, bucket and credentials when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(''));
    const env = {
      E2E_R2_URL: BUCKET,
      ...KEYS,
      ATTACHMENTS_R2_URL: OTHER_BUCKET,
      ATTACHMENTS_R2_ACCESS_KEY_ID: 'own-id',
      ATTACHMENTS_R2_SECRET_ACCESS_KEY: 'own-secret',
      ATTACHMENTS_R2_PREFIX: 'files',
    };
    const result = createAttachmentStore(env, e2e(env), fetcher);
    // A different bucket has no "old place" to look in.
    expect(result.split).toBeUndefined();
    await result.store.put('attachments/a', Buffer.from('x'));
    const request = fetcher.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`${OTHER_BUCKET}/files/attachments/a`);
    expect(request.headers.get('authorization')).toContain('Credential=own-id/');
  });

  it('shares the E2E credentials unless told otherwise, and works without an E2E bucket', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(''));
    const shared = createAttachmentStore(
      { E2E_R2_URL: BUCKET, ...KEYS, ATTACHMENTS_R2_URL: OTHER_BUCKET },
      e2e({}),
      fetcher,
    );
    await shared.store.put('attachments/a', Buffer.from('x'));
    expect((fetcher.mock.calls[0]![0] as Request).headers.get('authorization')).toContain(
      'Credential=id/',
    );

    const alone = createAttachmentStore(
      {
        ATTACHMENTS_R2_URL: OTHER_BUCKET,
        ATTACHMENTS_R2_ACCESS_KEY_ID: 'a',
        ATTACHMENTS_R2_SECRET_ACCESS_KEY: 'b',
      },
      e2e({}),
    );
    expect(alone.kind).toBe('r2');
    expect(alone.split).toBeUndefined();
  });

  it('asks for credentials, and skips the old place when the folders are the same', () => {
    expect(() => createAttachmentStore({ ATTACHMENTS_R2_URL: OTHER_BUCKET }, e2e({}))).toThrow(
      'ATTACHMENTS_R2_URL requires',
    );
    const same = createAttachmentStore(
      { E2E_R2_URL: BUCKET, ...KEYS, ATTACHMENTS_R2_PREFIX: 'e2e' },
      e2e({}),
    );
    expect(same.split).toBeUndefined();
    // The E2E bucket without its credentials cannot be read as an old place.
    const noKeys = createAttachmentStore(
      {
        E2E_R2_URL: BUCKET,
        ATTACHMENTS_R2_ACCESS_KEY_ID: 'a',
        ATTACHMENTS_R2_SECRET_ACCESS_KEY: 'b',
      },
      e2e({}),
    );
    expect(noKeys.split).toBeUndefined();
    expect(e2e({}).store).toBeInstanceOf(PrismaE2eArtifactStore);
  });
});

describe('LegacyFallbackArtifactStore', () => {
  const setup = () => {
    const primary = new InMemoryE2eArtifactStore();
    const legacy = new InMemoryE2eArtifactStore();
    return { primary, legacy, store: new LegacyFallbackArtifactStore(primary, legacy) };
  };

  it('writes to the new place and reads from either, new first', async () => {
    const { primary, legacy, store } = setup();
    await legacy.put('attachments/ws/old/content', Buffer.from('old'));
    await store.put('attachments/ws/new/content', Buffer.from('new'));
    expect(await primary.get('attachments/ws/new/content')).toEqual(Buffer.from('new'));
    expect(await legacy.get('attachments/ws/new/content')).toBeNull();
    expect(await store.get('attachments/ws/old/content')).toEqual(Buffer.from('old'));
    expect(await store.get('attachments/ws/new/content')).toEqual(Buffer.from('new'));
    expect(await store.get('attachments/ws/none/content')).toBeNull();
    await legacy.put('images/scope/ws/a.png', Buffer.from('img'));
    expect(await store.get('images/scope/ws/a.png')).toEqual(Buffer.from('img'));
  });

  it('never looks for E2E artifacts in the old place', async () => {
    const { legacy, store } = setup();
    const get = vi.spyOn(legacy, 'get');
    expect(await store.get('ws/creation/video.mp4')).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(await store.listKeys('ws')).toEqual([]);
  });

  it('lists both places without repeating a key, and deletes from both', async () => {
    const { primary, legacy, store } = setup();
    await primary.put('attachments/ws/a/content', Buffer.from('1'));
    await legacy.put('attachments/ws/a/content', Buffer.from('1'));
    await legacy.put('attachments/ws/b/content', Buffer.from('2'));
    expect((await store.listKeys('attachments')).sort()).toEqual([
      'attachments/ws/a/content',
      'attachments/ws/b/content',
    ]);

    await store.removePrefix('attachments/ws/a');
    expect(await primary.get('attachments/ws/a/content')).toBeNull();
    expect(await legacy.get('attachments/ws/a/content')).toBeNull();
    expect(await legacy.get('attachments/ws/b/content')).not.toBeNull();

    // E2E prefixes are only deleted in the new place.
    await legacy.put('ws/video.mp4', Buffer.from('v'));
    await store.removePrefix('ws');
    expect(await legacy.get('ws/video.mp4')).not.toBeNull();
  });

  it('treats storages that cannot list as empty, and signs through the new place', async () => {
    const quiet = (): E2eArtifactStore => ({
      put: async () => undefined,
      get: async () => null,
      removePrefix: async () => undefined,
    });
    const store = new LegacyFallbackArtifactStore(quiet(), quiet());
    expect(await store.listKeys('attachments')).toEqual([]);
    await expect(store.signedUrl('attachments/a', 60)).rejects.toThrow('cannot sign');

    const signing: E2eArtifactStore = { ...quiet(), signedUrl: async (key) => `https://s/${key}` };
    expect(await new LegacyFallbackArtifactStore(signing, quiet()).signedUrl('k', 60)).toBe(
      'https://s/k',
    );
  });
});

describe('migrateAttachments', () => {
  const seed = async () => {
    const legacy = new InMemoryE2eArtifactStore();
    const target = new InMemoryE2eArtifactStore();
    await legacy.put('attachments/ws/1/content', Buffer.from('one'));
    await legacy.put('attachments/ws/1/meta.json', Buffer.from('{}'));
    await legacy.put('images/issue/ws/a.png', Buffer.from('png'));
    await legacy.put('ws/creation/video.mp4', Buffer.from('video'));
    return { legacy, target };
  };

  it('only reports in a dry run', async () => {
    const { legacy, target } = await seed();
    const lines: string[] = [];
    const report = await migrateAttachments({
      legacy,
      target,
      apply: false,
      deleteLegacy: true,
      log: (line) => lines.push(line),
    });
    expect(report).toMatchObject({ found: 3, copied: 3, alreadyThere: 0, deleted: 0, bytes: 8 });
    expect(report.failed).toEqual([]);
    expect(lines.every((line) => line.startsWith('would copy'))).toBe(true);
    expect(await target.listKeys('attachments')).toEqual([]);
    expect(await legacy.get('attachments/ws/1/content')).not.toBeNull();
  });

  it('copies attachments and images, never the E2E artifacts, and verifies each copy', async () => {
    const { legacy, target } = await seed();
    const report = await migrateAttachments({ legacy, target, apply: true, deleteLegacy: false });
    expect(report).toMatchObject({ copied: 3, deleted: 0, alreadyThere: 0 });
    expect(await target.get('attachments/ws/1/content')).toEqual(Buffer.from('one'));
    expect(await target.get('images/issue/ws/a.png')).toEqual(Buffer.from('png'));
    expect(await target.get('ws/creation/video.mp4')).toBeNull();
    // The originals stay until asked.
    expect(await legacy.get('attachments/ws/1/content')).not.toBeNull();
  });

  it('can be repeated, and removes originals only once their copy is confirmed', async () => {
    const { legacy, target } = await seed();
    await migrateAttachments({ legacy, target, apply: true, deleteLegacy: false });
    const again = await migrateAttachments({ legacy, target, apply: true, deleteLegacy: true });
    expect(again).toMatchObject({ copied: 0, alreadyThere: 3, deleted: 3 });
    expect(await legacy.listKeys('attachments')).toEqual([]);
    expect(await legacy.get('ws/creation/video.mp4')).not.toBeNull();
    expect(await target.get('attachments/ws/1/content')).toEqual(Buffer.from('one'));
  });

  it('keeps the original of a file whose copy does not match, and reports it', async () => {
    const { legacy, target } = await seed();
    const lines: string[] = [];
    const corrupting: E2eArtifactStore = {
      put: async (key, content) =>
        target.put(key, key.endsWith('meta.json') ? Buffer.from('garbled') : content),
      get: (key) => target.get(key),
      removePrefix: (prefix) => target.removePrefix(prefix),
    };
    const report = await migrateAttachments({
      legacy,
      target: corrupting,
      apply: true,
      deleteLegacy: true,
      log: (line) => lines.push(line),
    });
    expect(report.failed).toEqual(['attachments/ws/1/meta.json']);
    expect(report.deleted).toBe(2);
    expect(await legacy.get('attachments/ws/1/meta.json')).not.toBeNull();
    expect(lines.some((line) => line.includes('did not match'))).toBe(true);
  });

  it('reports a file that disappears while migrating, and needs a storage that can list', async () => {
    const { legacy, target } = await seed();
    const lines: string[] = [];
    const flaky: E2eArtifactStore = {
      put: (key, content) => legacy.put(key, content),
      get: async (key) => (key.endsWith('a.png') ? null : legacy.get(key)),
      removePrefix: (prefix) => legacy.removePrefix(prefix),
      listKeys: (prefix) => legacy.listKeys(prefix),
    };
    const report = await migrateAttachments({
      legacy: flaky,
      target,
      apply: true,
      deleteLegacy: false,
      log: (line) => lines.push(line),
    });
    expect(report.failed).toEqual(['images/issue/ws/a.png']);
    expect(lines.some((line) => line.includes('could not be read'))).toBe(true);
    await migrateAttachments({ legacy: flaky, target, apply: false, deleteLegacy: false });

    await expect(
      migrateAttachments({
        legacy: {
          put: async () => undefined,
          get: async () => null,
          removePrefix: async () => undefined,
        },
        target,
        apply: false,
        deleteLegacy: false,
      }),
    ).rejects.toThrow('cannot list');
  });
});
