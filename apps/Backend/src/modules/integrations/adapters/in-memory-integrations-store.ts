import { randomUUID } from 'node:crypto';
import type { IntegrationCategory } from '../../../contracts/integrations.js';
import type {
  SaveIntegrationData,
  UserIntegrationRecord,
  UserIntegrationStore,
} from '../application/integrations-store.js';

export class InMemoryUserIntegrationStore implements UserIntegrationStore {
  private readonly store = new Map<string, UserIntegrationRecord>();

  private makeKey(ownerId: string, category: IntegrationCategory, providerId: string): string {
    return `${ownerId}:${category}:${providerId}`;
  }

  public listByOwner(ownerId: string): Promise<readonly UserIntegrationRecord[]> {
    const list = Array.from(this.store.values()).filter((item) => item.ownerId === ownerId);
    return Promise.resolve(list);
  }

  public getByOwner(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<UserIntegrationRecord | null> {
    const key = this.makeKey(ownerId, category, providerId);
    return Promise.resolve(this.store.get(key) ?? null);
  }

  public upsert(data: SaveIntegrationData): Promise<UserIntegrationRecord> {
    const key = this.makeKey(data.ownerId, data.category, data.providerId);
    const existing = this.store.get(key);
    const now = new Date();

    const record: UserIntegrationRecord = {
      id: existing ? existing.id : randomUUID(),
      ownerId: data.ownerId,
      category: data.category,
      providerId: data.providerId,
      isEnabled: data.isEnabled,
      settings: data.settings,
      encryptedSecrets:
        data.encryptedSecrets !== undefined
          ? data.encryptedSecrets
          : (existing?.encryptedSecrets ?? null),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.store.set(key, record);
    return Promise.resolve(record);
  }

  public delete(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<boolean> {
    const key = this.makeKey(ownerId, category, providerId);
    return Promise.resolve(this.store.delete(key));
  }
}
