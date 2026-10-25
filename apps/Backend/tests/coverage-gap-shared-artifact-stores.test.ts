import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaE2eArtifactStore } from '../src/modules/e2e/adapters/prisma-e2e-artifact-store.js';
import { R2ArtifactStore } from '../src/modules/e2e/adapters/r2-artifact-store.js';
import {
  FileSystemE2eArtifactStore,
  InMemoryE2eArtifactStore,
} from '../src/modules/e2e/application/artifact-store.js';

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('artifact store key listing', () => {
  it('lists files under a prefix on disk and nothing for a missing folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-'));
    roots.push(root);
    const store = new FileSystemE2eArtifactStore(root);
    await store.put('attachments/ws/a/meta.json', Buffer.from('{}'));
    await store.put('attachments/ws/a/content', Buffer.from('x'));
    await store.put('other/b', Buffer.from('y'));
    expect((await store.listKeys('attachments')).sort()).toEqual([
      'attachments/ws/a/content',
      'attachments/ws/a/meta.json',
    ]);
    expect(await store.listKeys('missing')).toEqual([]);
  });

  it('keeps keys in memory only for the exact prefix folder', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put('runs/1', Buffer.from('a'));
    await store.put('runs/1/video.mp4', Buffer.from('b'));
    await store.put('runs/10', Buffer.from('c'));
    expect(await store.listKeys('runs/1')).toEqual(['runs/1', 'runs/1/video.mp4']);
  });

  it('asks Postgres for the prefix and its children', async () => {
    const findMany = vi.fn().mockResolvedValue([{ key: 'runs/1' }, { key: 'runs/1/a' }]);
    const store = new PrismaE2eArtifactStore({
      e2eArtifactRecord: { findMany },
    } as unknown as PrismaClient);
    expect(await store.listKeys('runs/1')).toEqual(['runs/1', 'runs/1/a']);
    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ key: 'runs/1' }, { key: { startsWith: 'runs/1/' } }] },
      select: { key: true },
    });
  });

  it('lists R2 keys relative to its folder, with or without a folder', async () => {
    const xml =
      '<ListBucketResult><Key>e2e/runs/1</Key><Key>e2e/runs/1/v.mp4</Key><Key>e2e/runs/10</Key></ListBucketResult>';
    const fetcher = vi.fn(async () => new Response(xml));
    const options = {
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'bucket',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      fetcher: fetcher as unknown as typeof fetch,
    };
    expect(await new R2ArtifactStore(options).listKeys('runs/1')).toEqual([
      'runs/1',
      'runs/1/v.mp4',
    ]);
    const bare = new R2ArtifactStore({ ...options, prefix: '/' });
    fetcher.mockResolvedValueOnce(
      new Response('<ListBucketResult><Key>runs/1</Key><Key>runs/2</Key></ListBucketResult>'),
    );
    expect(await bare.listKeys('runs/1')).toEqual(['runs/1']);
  });
});
