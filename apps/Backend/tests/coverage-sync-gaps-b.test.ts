import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaE2eStore } from '../src/modules/e2e/adapters/prisma-e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { ExplorationRecorder } from '../src/modules/e2e/application/e2e-exploration.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';

const creation = { workspaceId: 'ws', id: 'run' };

describe('ExplorationRecorder keeping the script', () => {
  const keepFailing = (reason: unknown) =>
    ExplorationRecorder.start(new InMemoryE2eArtifactStore(), creation, false, () => 1_000, {
      keep: async () => {
        throw reason;
      },
    });

  it('records why the script could not be kept, whatever was thrown', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const reason of [new Error('disk full'), 'plain failure']) {
        const recorder = await keepFailing(reason);
        await recorder.finish();
        expect(logged).toHaveBeenCalledWith('[E2eExploration] Could not keep the script:', reason);
      }
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps going when the state cannot be saved after the script', async () => {
    const artifacts = new InMemoryE2eArtifactStore();
    let kept = false;
    const recorder = await ExplorationRecorder.start(artifacts, creation, false, () => 1_000, {
      keep: async () => {
        kept = true;
        return 'database';
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = artifacts.put.bind(artifacts);
    const put = vi
      .spyOn(artifacts, 'put')
      .mockImplementation((...args) =>
        kept ? Promise.reject(new Error('storage down')) : original(...args),
      );
    try {
      await recorder.finish();
      expect(logged).toHaveBeenCalledWith('[E2eExploration] Could not record:', expect.any(Error));
    } finally {
      put.mockRestore();
      logged.mockRestore();
    }
  });
});

describe('PrismaE2eStore exploration scripts', () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    id: 's1',
    workspaceId: 'ws',
    creationId: 'run',
    status: 'ready',
    script: [{ action: 'click' }],
    pages: [{ url: 'http://app/' }],
    ...extra,
  });

  function setup() {
    const record = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row(), ...data })),
      findMany: vi.fn(async () => [
        row(),
        row({ id: 's2', status: 'failed', script: null, pages: 'broken' }),
      ]),
      findFirst: vi.fn(async () => row()),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    };
    const store = new PrismaE2eStore({
      e2eExplorationScriptRecord: record,
    } as unknown as PrismaClient);
    return { store, record };
  }

  it('saves a script and reads it back', async () => {
    const { store, record } = setup();
    const saved = await store.saveExplorationScript({
      workspaceId: 'ws',
      creationId: 'run',
      script: [],
      pages: [],
    } as never);
    expect(saved).toMatchObject({ status: 'ready', script: [], pages: [] });
    expect(record.create).toHaveBeenCalledOnce();
  });

  it('lists the scripts of a workspace or of one run, tolerating odd stored JSON', async () => {
    const { store, record } = setup();
    const all = await store.listExplorationScripts('ws');
    expect(record.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws' },
      orderBy: { createdAt: 'desc' },
    });
    expect(all.map((script) => script.status)).toEqual(['ready', 'failed']);
    expect(all[1]).toMatchObject({ script: [], pages: [] });
    await store.listExplorationScripts('ws', 'run');
    expect(record.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws', creationId: 'run' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('gets and deletes a script of the workspace', async () => {
    const { store, record } = setup();
    expect(await store.getExplorationScript('ws', 's1')).toMatchObject({ id: 's1' });
    record.findFirst.mockResolvedValueOnce(null as never);
    expect(await store.getExplorationScript('ws', 'missing')).toBeNull();
    expect(await store.deleteExplorationScript('ws', 's1')).toBe(true);
    record.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.deleteExplorationScript('ws', 's1')).toBe(false);
  });
});

describe('InMemoryE2eStore deleting a run', () => {
  it('keeps the exploration scripts of the other runs', async () => {
    const store = new InMemoryE2eStore();
    const first = await store.createCreation({
      workspaceId: 'ws',
      name: 'one',
      prdFileNames: [],
    } as never);
    const second = await store.createCreation({
      workspaceId: 'ws',
      name: 'two',
      prdFileNames: [],
    } as never);
    for (const item of [first, second])
      await store.saveExplorationScript({
        workspaceId: 'ws',
        creationId: item.id,
        script: [],
        pages: [],
      } as never);
    expect(await store.deleteCreation('ws', first.id)).toBe(true);
    const left = await store.listExplorationScripts('ws');
    expect(left.map((script) => script.creationId)).toEqual([second.id]);
  });
});
