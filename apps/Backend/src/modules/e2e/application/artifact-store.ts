import fs from 'node:fs/promises';
import path from 'node:path';

/** Stores binary run artifacts (test videos) by an opaque, server-generated key. */
export interface E2eArtifactStore {
  put(key: string, content: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  removePrefix(prefix: string): Promise<void>;
  /**
   * Temporary URL the browser can load directly (object storage only), so videos stream
   * from the storage instead of through the API.
   */
  signedUrl?(key: string, expiresInSeconds: number): Promise<string>;
}

const SAFE_KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

function assertKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').some((part) => part === '..' || part === '.'))
    throw new Error(`Invalid artifact key: ${key}`);
}

export class InMemoryE2eArtifactStore implements E2eArtifactStore {
  private readonly items = new Map<string, Buffer>();

  put(key: string, content: Uint8Array): Promise<void> {
    assertKey(key);
    this.items.set(key, Buffer.from(content));
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | null> {
    assertKey(key);
    return Promise.resolve(this.items.get(key) ?? null);
  }

  removePrefix(prefix: string): Promise<void> {
    assertKey(prefix);
    for (const key of [...this.items.keys()])
      if (key === prefix || key.startsWith(`${prefix}/`)) this.items.delete(key);
    return Promise.resolve();
  }
}

/**
 * Keeps artifacts on local disk. On ephemeral hosts (e.g. Railway) point E2E_ARTIFACTS_DIR
 * at a mounted volume, otherwise videos disappear on redeploy.
 */
export class FileSystemE2eArtifactStore implements E2eArtifactStore {
  constructor(private readonly root: string) {}

  async put(key: string, content: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async removePrefix(prefix: string): Promise<void> {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }

  private resolve(key: string): string {
    assertKey(key);
    return path.join(this.root, ...key.split('/'));
  }
}
