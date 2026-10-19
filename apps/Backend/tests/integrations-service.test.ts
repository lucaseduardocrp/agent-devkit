import { describe, expect, it } from 'vitest';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';

describe('IntegrationsService', () => {
  it('saves, masks, and retrieves user integrations', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);

    // Save with a secret
    const saved = await service.saveIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki', {
      isEnabled: true,
      settings: { organization: 'my-org', projectId: 'my-project' },
      secret: 'my-secret-pat-123',
    });

    expect(saved.hasSecret).toBe(true);
    expect(saved.maskedSecret).toBe('••••••••');
    expect(saved.settings).toEqual({ organization: 'my-org', projectId: 'my-project' });

    // List integrations
    const list = await service.listIntegrations('owner-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.hasSecret).toBe(true);
    expect(list[0]?.maskedSecret).toBe('••••••••');

    // Get single integration
    const single = await service.getIntegration('owner-1', 'KNOWLEDGE', 'azure_devops_wiki');
    expect(single?.providerId).toBe('azure_devops_wiki');

    const missing = await service.getIntegration('owner-1', 'LLM', 'missing');
    expect(missing).toBeNull();

    // Verify decrypted secret
    const decrypted = await service.getDecryptedSecret('owner-1', 'KNOWLEDGE', 'azure_devops_wiki');
    expect(decrypted).toBe('my-secret-pat-123');
  });

  it('preserves existing secret when secret is omitted on update', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);

    await service.saveIntegration('owner-1', 'LLM', 'gemini', {
      isEnabled: true,
      settings: { model: 'gemini-1.5-flash' },
      secret: 'original-api-key',
    });

    // Update settings only (secret undefined)
    const updated = await service.saveIntegration('owner-1', 'LLM', 'gemini', {
      isEnabled: false,
      settings: { model: 'gemini-2.0-flash' },
    });

    expect(updated.hasSecret).toBe(true);
    expect(updated.isEnabled).toBe(false);
    expect(updated.settings).toEqual({ model: 'gemini-2.0-flash' });

    // Decrypted secret still matches original
    const decrypted = await service.getDecryptedSecret('owner-1', 'LLM', 'gemini');
    expect(decrypted).toBe('original-api-key');
  });

  it('clears secret when an empty string is supplied', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);

    await service.saveIntegration('owner-1', 'LLM', 'ollama', {
      isEnabled: true,
      settings: { url: 'http://localhost:11434' },
      secret: 'old-secret',
    });

    const cleared = await service.saveIntegration('owner-1', 'LLM', 'ollama', {
      isEnabled: true,
      settings: { url: 'http://localhost:11434' },
      secret: '   ',
    });

    expect(cleared.hasSecret).toBe(false);
    expect(cleared.maskedSecret).toBeUndefined();

    const decrypted = await service.getDecryptedSecret('owner-1', 'LLM', 'ollama');
    expect(decrypted).toBeNull();
  });

  it('handles getDecryptedSecret for non-existent records or records without secret', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);

    expect(await service.getDecryptedSecret('owner-1', 'LLM', 'not-there')).toBeNull();

    await service.saveIntegration('owner-1', 'LLM', 'no-secret', {
      isEnabled: true,
      settings: {},
    });
    expect(await service.getDecryptedSecret('owner-1', 'LLM', 'no-secret')).toBeNull();
  });

  it('deletes an integration', async () => {
    const store = new InMemoryUserIntegrationStore();
    const service = new IntegrationsService(store);

    await service.saveIntegration('owner-1', 'PROJECT_MANAGEMENT', 'github_projects', {
      isEnabled: true,
      settings: { repo: 'adk' },
    });

    expect(
      await service.deleteIntegration('owner-1', 'PROJECT_MANAGEMENT', 'github_projects'),
    ).toBe(true);
    expect(
      await service.getIntegration('owner-1', 'PROJECT_MANAGEMENT', 'github_projects'),
    ).toBeNull();
  });
});
