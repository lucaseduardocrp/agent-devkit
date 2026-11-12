import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  DesignService,
  type DesignRemoteStore,
} from '../src/modules/design/application/design-service.js';
import { PrismaDesignSettingsStore } from '../src/modules/design/adapters/prisma-design-settings-store.js';
import {
  InMemoryDesignSettingsStore,
  type DesignSettings,
} from '../src/modules/design/application/design-settings-store.js';

const settings: DesignSettings = {
  provider: 'github',
  repositoryId: '1',
  repositoryName: 'acme/design',
  branch: 'main',
};

describe('PrismaDesignSettingsStore', () => {
  function setup(row: (DesignSettings & { workspaceId: string }) | null) {
    const record = {
      findUnique: vi.fn().mockResolvedValue(row),
      upsert: vi.fn().mockResolvedValue({ workspaceId: 'ws', ...settings }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const store = new PrismaDesignSettingsStore({
      designSettingsRecord: record,
    } as unknown as PrismaClient);
    return { store, record };
  }

  it('reads the saved repository of a workspace, or null when none was chosen', async () => {
    const found = setup({ workspaceId: 'ws', ...settings });
    expect(await found.store.get('ws')).toEqual(settings);
    expect(found.record.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws' } });
    expect(await setup(null).store.get('ws')).toBeNull();
  });

  it('upserts the chosen repository and returns it without the workspace id', async () => {
    const { store, record } = setup(null);
    expect(await store.save('ws', settings)).toEqual(settings);
    expect(record.upsert).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      create: { workspaceId: 'ws', ...settings },
      update: settings,
    });
  });

  it('clears only the settings of the workspace', async () => {
    const { store, record } = setup(null);
    await store.clear('ws');
    expect(record.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws' } });
  });
});

describe('InMemoryDesignSettingsStore', () => {
  it('keeps the settings per workspace until they are cleared', async () => {
    const store = new InMemoryDesignSettingsStore();
    expect(await store.get('a')).toBeNull();
    expect(await store.save('a', settings)).toBe(settings);
    expect(await store.get('a')).toBe(settings);
    expect(await store.get('b')).toBeNull();
    await store.clear('a');
    expect(await store.get('a')).toBeNull();
  });
});

describe('DesignService without a settings store', () => {
  it('reports the settings as unavailable', async () => {
    const service = new DesignService({} as DesignRemoteStore, {} as AgentService);
    await expect(service.getSettings('ws')).rejects.toMatchObject({
      code: 'DESIGN_SETTINGS_UNAVAILABLE',
      statusCode: 503,
    });
  });
});
