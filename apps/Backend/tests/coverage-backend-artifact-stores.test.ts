import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  createAttachmentStore,
  createE2eArtifactStore,
} from '../src/modules/e2e/adapters/artifact-store-factory.js';
import { PrismaE2eArtifactStore } from '../src/modules/e2e/adapters/prisma-e2e-artifact-store.js';
import { R2ArtifactStore } from '../src/modules/e2e/adapters/r2-artifact-store.js';
import { FileSystemE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';

describe('FileSystemE2eArtifactStore.listKeys', () => {
  let root = '';
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = '';
  });

  it('lists the files under a prefix as slash-separated keys', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-'));
    const store = new FileSystemE2eArtifactStore(root);
    await store.put('ws/run-1/video.mp4', Buffer.from('1'));
    await store.put('ws/run-1/steps/shot.png', Buffer.from('2'));
    await store.put('ws/run-2/video.mp4', Buffer.from('3'));
    expect((await store.listKeys('ws/run-1')).sort()).toEqual([
      'ws/run-1/steps/shot.png',
      'ws/run-1/video.mp4',
    ]);
  });

  it('lists nothing for a prefix that does not exist', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-'));
    expect(await new FileSystemE2eArtifactStore(root).listKeys('missing')).toEqual([]);
  });
});

describe('PrismaE2eArtifactStore.listKeys', () => {
  it('asks for the exact key and the keys below it', async () => {
    const findMany = vi.fn().mockResolvedValue([{ key: 'ws/a.mp4' }, { key: 'ws/b.mp4' }]);
    const store = new PrismaE2eArtifactStore({
      e2eArtifactRecord: { findMany },
    } as unknown as PrismaClient);
    expect(await store.listKeys('ws')).toEqual(['ws/a.mp4', 'ws/b.mp4']);
    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ key: 'ws' }, { key: { startsWith: 'ws/' } }] },
      select: { key: true },
    });
  });
});

describe('R2ArtifactStore.listKeys', () => {
  const listing = (keys: string[]) =>
    `<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`;

  it('returns keys relative to the store folder and ignores look-alike prefixes', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(listing(['e2e/ws/run-1/a.mp4', 'e2e/ws/run-1', 'e2e/ws/run-10/b.mp4'])),
      );
    const store = new R2ArtifactStore({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await store.listKeys('ws/run-1')).toEqual(['ws/run-1/a.mp4', 'ws/run-1']);
  });

  it('keeps full keys when the store has no folder', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(listing(['ws/a.mp4'])));
    const store = new R2ArtifactStore({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      prefix: '',
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await store.listKeys('ws')).toEqual(['ws/a.mp4']);
  });
});

describe('createAttachmentStore with a custom E2E folder', () => {
  it('finds old attachments in the folder the E2E artifacts use', async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response('', { status: (input as Request).method === 'GET' ? 404 : 200 }),
      ),
    );
    const env = {
      E2E_R2_URL: 'https://acct.r2.cloudflarestorage.com/the-bucket',
      E2E_R2_ACCESS_KEY_ID: 'id',
      E2E_R2_SECRET_ACCESS_KEY: 'secret',
      E2E_R2_PREFIX: 'videos',
    };
    const result = createAttachmentStore(
      env,
      createE2eArtifactStore(env, {} as PrismaClient, fetcher as unknown as typeof fetch),
      fetcher as unknown as typeof fetch,
    );
    expect(result.split).toBeDefined();
    await result.store.get('attachments/ws/1/content');
    expect(fetcher.mock.calls.map((call) => (call[0] as Request).url)).toEqual([
      'https://acct.r2.cloudflarestorage.com/the-bucket/attachments/ws/1/content',
      'https://acct.r2.cloudflarestorage.com/the-bucket/videos/attachments/ws/1/content',
    ]);
  });
});
