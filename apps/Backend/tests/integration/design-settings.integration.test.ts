import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import { PrismaDesignSettingsStore } from '../../src/modules/design/adapters/prisma-design-settings-store.js';
import type { DesignSettings } from '../../src/modules/design/application/design-settings-store.js';

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required by the integration test configuration.');
  }
  return value;
}

const testDatabaseUrl = requireTestDatabaseUrl();
const runPrefix = `integration-test-${randomUUID()}`;

const settings = (overrides: Partial<DesignSettings> = {}): DesignSettings => ({
  provider: 'github',
  repositoryId: '123',
  repositoryName: 'acme/designs',
  branch: 'main',
  ...overrides,
});

async function withStore<T>(
  operation: (store: PrismaDesignSettingsStore, database: PostgresDatabase) => Promise<T>,
): Promise<T> {
  const database = new PostgresDatabase(testDatabaseUrl);
  try {
    return await operation(new PrismaDesignSettingsStore(database.client), database);
  } finally {
    await database.close();
  }
}

afterAll(async () => {
  const database = new PostgresDatabase(testDatabaseUrl);
  try {
    await database.client.designSettingsRecord.deleteMany({
      where: { workspaceId: { startsWith: runPrefix } },
    });
  } finally {
    await database.close();
  }
});

describe('PrismaDesignSettingsStore', () => {
  it('answers null for a workspace that never saved settings', async () => {
    await withStore(async (store) => {
      expect(await store.get(`${runPrefix}-missing`)).toBeNull();
    });
  });

  it('creates settings on the first save and reads them back', async () => {
    const workspaceId = `${runPrefix}-create`;
    await withStore(async (store) => {
      const saved = await store.save(workspaceId, settings());
      expect(saved).toEqual(settings());
      expect(await store.get(workspaceId)).toEqual(settings());
    });
  });

  it('updates settings already saved for the workspace, replacing every field', async () => {
    const workspaceId = `${runPrefix}-update`;
    await withStore(async (store) => {
      await store.save(workspaceId, settings());
      const updated = await store.save(
        workspaceId,
        settings({ provider: 'azure', repositoryName: 'Project/Repo', branch: 'develop' }),
      );
      expect(updated.branch).toBe('develop');
      expect(await store.get(workspaceId)).toMatchObject({
        provider: 'azure',
        repositoryName: 'Project/Repo',
        branch: 'develop',
      });
    });
  });

  it('clears settings, and clearing again is a no-op', async () => {
    const workspaceId = `${runPrefix}-clear`;
    await withStore(async (store) => {
      await store.save(workspaceId, settings());
      await store.clear(workspaceId);
      expect(await store.get(workspaceId)).toBeNull();
      await expect(store.clear(workspaceId)).resolves.toBeUndefined();
    });
  });
});
