import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { E2eArtifactStore } from '../application/artifact-store.js';

/**
 * Keeps test videos in Postgres so the API and every worker instance see the same files
 * and nothing is lost on redeploy. Videos are small (H.264, typically 0.1–1 MB).
 */
export class PrismaE2eArtifactStore implements E2eArtifactStore {
  constructor(private readonly db: PrismaClient) {}

  async put(key: string, content: Uint8Array): Promise<void> {
    const bytes = new Uint8Array(content);
    await this.db.e2eArtifactRecord.upsert({
      where: { key },
      create: { key, content: bytes },
      update: { content: bytes, createdAt: new Date() },
    });
  }

  async get(key: string): Promise<Buffer | null> {
    const row = await this.db.e2eArtifactRecord.findUnique({ where: { key } });
    return row ? Buffer.from(row.content) : null;
  }

  async removePrefix(prefix: string): Promise<void> {
    await this.db.e2eArtifactRecord.deleteMany({
      where: { OR: [{ key: prefix }, { key: { startsWith: `${prefix}/` } }] },
    });
  }
}
