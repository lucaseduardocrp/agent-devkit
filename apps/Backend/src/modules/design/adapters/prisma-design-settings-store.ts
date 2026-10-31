import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { DesignRepositoryProvider } from '../application/design-service.js';
import type { DesignSettings, DesignSettingsStore } from '../application/design-settings-store.js';

interface Row {
  provider: string;
  repositoryId: string;
  repositoryName: string;
  branch: string;
}

const toSettings = (row: Row): DesignSettings => ({
  provider: row.provider as DesignRepositoryProvider,
  repositoryId: row.repositoryId,
  repositoryName: row.repositoryName,
  branch: row.branch,
});

export class PrismaDesignSettingsStore implements DesignSettingsStore {
  constructor(private readonly db: PrismaClient) {}

  async get(workspaceId: string): Promise<DesignSettings | null> {
    const row = await this.db.designSettingsRecord.findUnique({ where: { workspaceId } });
    return row ? toSettings(row) : null;
  }

  async save(workspaceId: string, settings: DesignSettings): Promise<DesignSettings> {
    return toSettings(
      await this.db.designSettingsRecord.upsert({
        where: { workspaceId },
        create: { workspaceId, ...settings },
        update: settings,
      }),
    );
  }

  async clear(workspaceId: string): Promise<void> {
    await this.db.designSettingsRecord.deleteMany({ where: { workspaceId } });
  }
}
