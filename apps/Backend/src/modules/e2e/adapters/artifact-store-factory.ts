import path from 'node:path';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import {
  FileSystemE2eArtifactStore,
  type E2eArtifactStore,
} from '../application/artifact-store.js';
import { PrismaE2eArtifactStore } from './prisma-e2e-artifact-store.js';
import { R2ArtifactStore, parseR2Url } from './r2-artifact-store.js';

export type E2eArtifactStoreKind = 'r2' | 'postgres' | 'filesystem';

/**
 * Picks where test videos live, shared by the API and the worker so both agree:
 * Cloudflare R2 when configured, else Postgres, else local disk (development only).
 */
export function createE2eArtifactStore(
  env: NodeJS.ProcessEnv,
  database?: PrismaClient,
  fetcher?: typeof fetch,
): { kind: E2eArtifactStoreKind; store: E2eArtifactStore } {
  const r2Url = env['E2E_R2_URL']?.trim();
  if (r2Url) {
    const accessKeyId = env['E2E_R2_ACCESS_KEY_ID']?.trim();
    const secretAccessKey = env['E2E_R2_SECRET_ACCESS_KEY']?.trim();
    if (!accessKeyId || !secretAccessKey)
      throw new Error(
        'E2E_R2_URL requires E2E_R2_ACCESS_KEY_ID and E2E_R2_SECRET_ACCESS_KEY (R2 → Manage API Tokens).',
      );
    return {
      kind: 'r2',
      store: new R2ArtifactStore({
        ...parseR2Url(r2Url),
        accessKeyId,
        secretAccessKey,
        prefix: env['E2E_R2_PREFIX']?.trim() || 'e2e',
        fetcher,
      }),
    };
  }
  if (database) return { kind: 'postgres', store: new PrismaE2eArtifactStore(database) };
  return {
    kind: 'filesystem',
    store: new FileSystemE2eArtifactStore(
      env['E2E_ARTIFACTS_DIR'] || path.join(process.cwd(), '.e2e-artifacts'),
    ),
  };
}
