import path from 'node:path';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import {
  FileSystemE2eArtifactStore,
  type E2eArtifactStore,
} from '../application/artifact-store.js';
import { PrismaE2eArtifactStore } from './prisma-e2e-artifact-store.js';
import { R2ArtifactStore, parseR2Url } from './r2-artifact-store.js';

import { LegacyFallbackArtifactStore } from '../../shared/legacy-fallback-store.js';

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

export interface AttachmentStoreSetup {
  readonly kind: E2eArtifactStoreKind;
  readonly store: E2eArtifactStore;
  /** Present while files may still sit in the old E2E folder: where they go, and where they are. */
  readonly split?: { readonly target: E2eArtifactStore; readonly legacy: E2eArtifactStore };
}

/**
 * Where attachments and images live, apart from the E2E artifacts (test videos and screenshots):
 * - R2 with `ATTACHMENTS_R2_URL` (its own bucket; keys fall back to the E2E ones when omitted), or
 *   the E2E bucket when only `E2E_R2_URL` is set. The folder is `ATTACHMENTS_R2_PREFIX`, the root
 *   of the bucket by default, so the files sit in `attachments/` next to `e2e/`.
 * - Otherwise the E2E storage itself (Postgres), or `ATTACHMENTS_DIR` on local disk.
 * Files saved before the split are still found in the old place (`<E2E prefix>/attachments/...`)
 * until `npm run migrate:attachments` moves them.
 */
export function createAttachmentStore(
  env: NodeJS.ProcessEnv,
  e2e: { kind: E2eArtifactStoreKind; store: E2eArtifactStore },
  fetcher?: typeof fetch,
): AttachmentStoreSetup {
  const ownUrl = env['ATTACHMENTS_R2_URL']?.trim();
  const e2eUrl = env['E2E_R2_URL']?.trim();
  const url = ownUrl || e2eUrl;
  if (!url) {
    const dir = env['ATTACHMENTS_DIR']?.trim();
    if (dir && e2e.kind === 'filesystem')
      return { kind: 'filesystem', store: new FileSystemE2eArtifactStore(dir) };
    return e2e;
  }
  const e2eKeys = {
    accessKeyId: env['E2E_R2_ACCESS_KEY_ID']?.trim() ?? '',
    secretAccessKey: env['E2E_R2_SECRET_ACCESS_KEY']?.trim() ?? '',
  };
  const ownKeys = {
    accessKeyId: env['ATTACHMENTS_R2_ACCESS_KEY_ID']?.trim() || e2eKeys.accessKeyId,
    secretAccessKey: env['ATTACHMENTS_R2_SECRET_ACCESS_KEY']?.trim() || e2eKeys.secretAccessKey,
  };
  if (!ownKeys.accessKeyId || !ownKeys.secretAccessKey)
    throw new Error(
      'ATTACHMENTS_R2_URL requires ATTACHMENTS_R2_ACCESS_KEY_ID and ATTACHMENTS_R2_SECRET_ACCESS_KEY (or the E2E_R2_* ones).',
    );
  const prefix = env['ATTACHMENTS_R2_PREFIX']?.trim() ?? '';
  const store = new R2ArtifactStore({
    ...parseR2Url(url),
    ...ownKeys,
    prefix,
    fetcher,
  });

  // The old location exists only when attachments share the E2E bucket and now use another folder.
  const e2ePrefix = env['E2E_R2_PREFIX']?.trim() || 'e2e';
  const sameBucket = !ownUrl || ownUrl === e2eUrl;
  if (!e2eUrl || !sameBucket || prefix === e2ePrefix || !e2eKeys.accessKeyId) {
    return { kind: 'r2', store };
  }
  const legacy = new R2ArtifactStore({
    ...parseR2Url(e2eUrl),
    ...e2eKeys,
    prefix: e2ePrefix,
    fetcher,
  });
  return {
    kind: 'r2',
    store: new LegacyFallbackArtifactStore(store, legacy),
    split: { target: store, legacy },
  };
}
