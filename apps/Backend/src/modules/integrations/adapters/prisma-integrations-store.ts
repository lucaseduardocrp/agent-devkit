import type { IntegrationCategory } from '../../../contracts/integrations.js';
import type {
  SaveIntegrationData,
  UserIntegrationRecord,
  UserIntegrationStore,
} from '../application/integrations-store.js';

interface RawPrismaIntegrationRecord {
  id: string;
  ownerId: string;
  category: IntegrationCategory;
  providerId: string;
  isEnabled: boolean;
  settings: unknown;
  encryptedSecrets: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PrismaIntegrationDelegate {
  findMany(arguments_: {
    where: { ownerId: string };
    orderBy?: readonly Record<string, 'asc' | 'desc'>[];
  }): Promise<readonly RawPrismaIntegrationRecord[]>;

  findUnique(arguments_: {
    where: {
      ownerId_category_providerId: {
        ownerId: string;
        category: IntegrationCategory;
        providerId: string;
      };
    };
  }): Promise<RawPrismaIntegrationRecord | null>;

  upsert(arguments_: {
    where: {
      ownerId_category_providerId: {
        ownerId: string;
        category: IntegrationCategory;
        providerId: string;
      };
    };
    create: {
      ownerId: string;
      category: IntegrationCategory;
      providerId: string;
      isEnabled: boolean;
      settings: Record<string, unknown>;
      encryptedSecrets?: string | null;
    };
    update: {
      isEnabled?: boolean;
      settings?: Record<string, unknown>;
      encryptedSecrets?: string | null;
    };
  }): Promise<RawPrismaIntegrationRecord>;

  deleteMany(arguments_: {
    where: {
      ownerId: string;
      category: IntegrationCategory;
      providerId: string;
    };
  }): Promise<{ count: number }>;
}

export interface PrismaIntegrationsClient {
  readonly integrationRecord: PrismaIntegrationDelegate;
}

export class PrismaUserIntegrationStore implements UserIntegrationStore {
  public constructor(private readonly client: PrismaIntegrationsClient) {}

  public async listByOwner(ownerId: string): Promise<readonly UserIntegrationRecord[]> {
    const raw = await this.client.integrationRecord.findMany({
      where: { ownerId },
      orderBy: [{ category: 'asc' }, { providerId: 'asc' }],
    });
    return raw.map(toUserIntegrationRecord);
  }

  public async getByOwner(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<UserIntegrationRecord | null> {
    const raw = await this.client.integrationRecord.findUnique({
      where: {
        ownerId_category_providerId: { ownerId, category, providerId },
      },
    });
    return raw ? toUserIntegrationRecord(raw) : null;
  }

  public async upsert(data: SaveIntegrationData): Promise<UserIntegrationRecord> {
    const updateData: {
      isEnabled?: boolean;
      settings?: Record<string, unknown>;
      encryptedSecrets?: string | null;
    } = {
      isEnabled: data.isEnabled,
      settings: data.settings,
    };

    if (data.encryptedSecrets !== undefined) {
      updateData.encryptedSecrets = data.encryptedSecrets;
    }

    const raw = await this.client.integrationRecord.upsert({
      where: {
        ownerId_category_providerId: {
          ownerId: data.ownerId,
          category: data.category,
          providerId: data.providerId,
        },
      },
      create: {
        ownerId: data.ownerId,
        category: data.category,
        providerId: data.providerId,
        isEnabled: data.isEnabled,
        settings: data.settings,
        encryptedSecrets: data.encryptedSecrets ?? null,
      },
      update: updateData,
    });

    return toUserIntegrationRecord(raw);
  }

  public async delete(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<boolean> {
    const result = await this.client.integrationRecord.deleteMany({
      where: { ownerId, category, providerId },
    });
    return result.count > 0;
  }
}

function toUserIntegrationRecord(raw: RawPrismaIntegrationRecord): UserIntegrationRecord {
  return {
    id: raw.id,
    ownerId: raw.ownerId,
    category: raw.category,
    providerId: raw.providerId,
    isEnabled: raw.isEnabled,
    settings: (raw.settings as Record<string, unknown>) ?? {},
    encryptedSecrets: raw.encryptedSecrets,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
