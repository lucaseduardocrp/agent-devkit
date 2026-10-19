import { describe, expect, it } from 'vitest';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import {
  PrismaUserIntegrationStore,
  type PrismaIntegrationsClient,
} from '../src/modules/integrations/adapters/prisma-integrations-store.js';

describe('User Integration Stores', () => {
  describe('InMemoryUserIntegrationStore', () => {
    it('manages integration records isolated by owner', async () => {
      const store = new InMemoryUserIntegrationStore();

      const user1Record = await store.upsert({
        ownerId: 'owner-1',
        category: 'KNOWLEDGE',
        providerId: 'azure_devops_wiki',
        isEnabled: true,
        settings: { org: 'my-org' },
        encryptedSecrets: 'enc:123',
      });

      expect(user1Record.id).toBeDefined();
      expect(user1Record.ownerId).toBe('owner-1');

      // Verify listing isolates by owner
      const owner1List = await store.listByOwner('owner-1');
      expect(owner1List).toHaveLength(1);

      const owner2List = await store.listByOwner('owner-2');
      expect(owner2List).toHaveLength(0);

      // Verify getByOwner
      const found = await store.getByOwner('owner-1', 'KNOWLEDGE', 'azure_devops_wiki');
      expect(found?.settings).toEqual({ org: 'my-org' });

      // Update preserving secret
      const updated = await store.upsert({
        ownerId: 'owner-1',
        category: 'KNOWLEDGE',
        providerId: 'azure_devops_wiki',
        isEnabled: false,
        settings: { org: 'new-org' },
      });
      expect(updated.isEnabled).toBe(false);
      expect(updated.encryptedSecrets).toBe('enc:123');

      // Delete
      const deleted = await store.delete('owner-1', 'KNOWLEDGE', 'azure_devops_wiki');
      expect(deleted).toBe(true);

      expect(await store.getByOwner('owner-1', 'KNOWLEDGE', 'azure_devops_wiki')).toBeNull();
      expect(await store.delete('owner-1', 'KNOWLEDGE', 'azure_devops_wiki')).toBe(false);
    });
  });

  describe('PrismaUserIntegrationStore', () => {
    it('delegates CRUD calls to prisma client', async () => {
      const mockRaw = {
        id: 'rec-1',
        ownerId: 'owner-1',
        category: 'LLM' as const,
        providerId: 'gemini',
        isEnabled: true,
        settings: { model: 'gemini-1.5-pro' },
        encryptedSecrets: 'encrypted:pat',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockClient: PrismaIntegrationsClient = {
        integrationRecord: {
          findMany: async () => [mockRaw],
          findUnique: async ({ where }) => {
            if (where.ownerId_category_providerId.ownerId === 'owner-1') {
              return mockRaw;
            }
            return null;
          },
          upsert: async ({ create }) => ({
            ...mockRaw,
            settings: create.settings,
            encryptedSecrets: create.encryptedSecrets ?? null,
          }),
          deleteMany: async ({ where }) => ({
            count: where.ownerId === 'owner-1' ? 1 : 0,
          }),
        },
      };

      const store = new PrismaUserIntegrationStore(mockClient);

      const list = await store.listByOwner('owner-1');
      expect(list).toHaveLength(1);
      expect(list[0]?.providerId).toBe('gemini');

      const found = await store.getByOwner('owner-1', 'LLM', 'gemini');
      expect(found?.ownerId).toBe('owner-1');

      const missing = await store.getByOwner('owner-2', 'LLM', 'gemini');
      expect(missing).toBeNull();

      const upserted = await store.upsert({
        ownerId: 'owner-1',
        category: 'LLM',
        providerId: 'gemini',
        isEnabled: true,
        settings: { model: 'gemini-2.0' },
        encryptedSecrets: 'enc:new',
      });
      expect(upserted.settings).toEqual({ model: 'gemini-2.0' });

      // Upsert without encryptedSecrets passed
      const upsertedNoSecret = await store.upsert({
        ownerId: 'owner-1',
        category: 'LLM',
        providerId: 'gemini',
        isEnabled: true,
        settings: { model: 'gemini-2.0' },
      });
      expect(upsertedNoSecret.providerId).toBe('gemini');

      const deleted = await store.delete('owner-1', 'LLM', 'gemini');
      expect(deleted).toBe(true);

      const deleteFail = await store.delete('owner-2', 'LLM', 'gemini');
      expect(deleteFail).toBe(false);

      // Handle null settings fallback
      const nullSettingsClient: PrismaIntegrationsClient = {
        integrationRecord: {
          findMany: async () => [{ ...mockRaw, settings: null }],
          findUnique: async () => null,
          upsert: async () => ({ ...mockRaw, settings: null }),
          deleteMany: async () => ({ count: 0 }),
        },
      };
      const nullStore = new PrismaUserIntegrationStore(nullSettingsClient);
      const nullList = await nullStore.listByOwner('owner-1');
      expect(nullList[0]?.settings).toEqual({});
    });
  });
});
