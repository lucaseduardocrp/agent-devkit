import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';

/** Keys the attachments module writes; anything else belongs to the E2E module. */
const ATTACHMENT_KEY = /^(attachments|images)(\/|$)/;

/**
 * Attachments used to share the E2E folder of the bucket (`e2e/attachments/...`). Until their files
 * are moved to the attachments location, this store writes to the new place and still finds, lists
 * and deletes what is in the old one, so nothing breaks while both exist.
 */
export class LegacyFallbackArtifactStore implements E2eArtifactStore {
  constructor(
    private readonly primary: E2eArtifactStore,
    private readonly legacy: E2eArtifactStore,
  ) {}

  put(key: string, content: Uint8Array): Promise<void> {
    return this.primary.put(key, content);
  }

  async get(key: string): Promise<Buffer | null> {
    const found = await this.primary.get(key);
    if (found || !ATTACHMENT_KEY.test(key)) return found;
    return this.legacy.get(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const current = (await this.primary.listKeys?.(prefix)) ?? [];
    if (!ATTACHMENT_KEY.test(prefix)) return current;
    const old = (await this.legacy.listKeys?.(prefix)) ?? [];
    return [...new Set([...current, ...old])];
  }

  async removePrefix(prefix: string): Promise<void> {
    await this.primary.removePrefix(prefix);
    if (ATTACHMENT_KEY.test(prefix)) await this.legacy.removePrefix(prefix);
  }

  signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return this.primary.signedUrl
      ? this.primary.signedUrl(key, expiresInSeconds)
      : Promise.reject(new Error('This storage cannot sign URLs.'));
  }
}
