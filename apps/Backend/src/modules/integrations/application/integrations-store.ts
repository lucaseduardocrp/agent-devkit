import type { IntegrationCategory } from '../../../contracts/integrations.js';

export interface UserIntegrationRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly category: IntegrationCategory;
  readonly providerId: string;
  readonly isEnabled: boolean;
  readonly settings: Record<string, unknown>;
  readonly encryptedSecrets: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveIntegrationData {
  readonly ownerId: string;
  readonly category: IntegrationCategory;
  readonly providerId: string;
  readonly isEnabled: boolean;
  readonly settings: Record<string, unknown>;
  readonly encryptedSecrets?: string | null;
}

export interface UserIntegrationStore {
  listByOwner(ownerId: string): Promise<readonly UserIntegrationRecord[]>;
  getByOwner(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<UserIntegrationRecord | null>;
  upsert(data: SaveIntegrationData): Promise<UserIntegrationRecord>;
  delete(ownerId: string, category: IntegrationCategory, providerId: string): Promise<boolean>;
}
