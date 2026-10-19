import type {
  IntegrationCategory,
  IntegrationDTO,
  SaveIntegrationInput,
} from '../../../contracts/integrations.js';
import { decryptSecret, encryptSecret } from '../../../shared/encryption.js';
import type { UserIntegrationRecord, UserIntegrationStore } from './integrations-store.js';

export class IntegrationsService {
  public constructor(private readonly store: UserIntegrationStore) {}

  public async listIntegrations(ownerId: string): Promise<readonly IntegrationDTO[]> {
    const records = await this.store.listByOwner(ownerId);
    return records.map(toMaskedDTO);
  }

  public async getIntegration(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<IntegrationDTO | null> {
    const record = await this.store.getByOwner(ownerId, category, providerId);
    return record ? toMaskedDTO(record) : null;
  }

  public async saveIntegration(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
    input: SaveIntegrationInput,
  ): Promise<IntegrationDTO> {
    let encryptedSecrets: string | null | undefined = undefined;

    if (input.secret !== undefined) {
      const trimmed = input.secret.trim();
      encryptedSecrets = trimmed.length > 0 ? encryptSecret(trimmed) : null;
    }

    const saved = await this.store.upsert({
      ownerId,
      category,
      providerId,
      isEnabled: input.isEnabled,
      settings: input.settings,
      encryptedSecrets,
    });

    return toMaskedDTO(saved);
  }

  public async deleteIntegration(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<boolean> {
    return this.store.delete(ownerId, category, providerId);
  }

  public async getDecryptedSecret(
    ownerId: string,
    category: IntegrationCategory,
    providerId: string,
  ): Promise<string | null> {
    const record = await this.store.getByOwner(ownerId, category, providerId);
    if (!record || !record.encryptedSecrets) {
      return null;
    }
    return decryptSecret(record.encryptedSecrets);
  }
}

export function toMaskedDTO(record: UserIntegrationRecord): IntegrationDTO {
  const hasSecret = Boolean(record.encryptedSecrets);
  return {
    id: record.id,
    category: record.category,
    providerId: record.providerId,
    isEnabled: record.isEnabled,
    settings: record.settings,
    hasSecret,
    maskedSecret: hasSecret ? '••••••••' : undefined,
    updatedAt: record.updatedAt.toISOString(),
  };
}
