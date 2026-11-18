import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';

export interface MigrationReport {
  /** Objects found in the old location. */
  readonly found: number;
  /** Objects copied to the new location (or that would be, in a dry run). */
  readonly copied: number;
  /** Objects already in the new location with the same content. */
  readonly alreadyThere: number;
  /** Objects that could not be read from the old location or did not verify after the copy. */
  readonly failed: readonly string[];
  /** Objects removed from the old location. */
  readonly deleted: number;
  readonly bytes: number;
}

export interface MigrationOptions {
  readonly legacy: E2eArtifactStore;
  readonly target: E2eArtifactStore;
  /** Without it nothing is written or deleted: the report says what would happen. */
  readonly apply: boolean;
  /** Removes each object from the old location, only once its copy was read back and matched. */
  readonly deleteLegacy: boolean;
  readonly log?: (line: string) => void;
}

/** Folders the attachments module writes; see attachment.ts and image-attachment.ts. */
const FOLDERS = ['attachments', 'images'] as const;

/**
 * Moves the files of attachments and images from the E2E folder of the bucket to their own
 * location. It copies first, reads every copy back and compares it, and only then (when asked)
 * deletes the original, so an interrupted run leaves everything readable and can be repeated.
 */
export async function migrateAttachments(options: MigrationOptions): Promise<MigrationReport> {
  const log = options.log ?? (() => undefined);
  if (!options.legacy.listKeys) throw new Error('The old storage cannot list its files.');
  const keys = new Set<string>();
  for (const folder of FOLDERS)
    for (const key of await options.legacy.listKeys(folder)) keys.add(key);

  const failed: string[] = [];
  const safe: string[] = [];
  let copied = 0;
  let alreadyThere = 0;
  let bytes = 0;
  for (const key of keys) {
    const content = await options.legacy.get(key);
    if (!content) {
      failed.push(key);
      log(`! ${key}: could not be read from the old location`);
      continue;
    }
    bytes += content.length;
    const existing = await options.target.get(key);
    if (existing?.equals(content)) {
      alreadyThere += 1;
      safe.push(key);
      continue;
    }
    copied += 1;
    log(`${options.apply ? 'copy' : 'would copy'} ${key} (${content.length} B)`);
    if (!options.apply) continue;
    await options.target.put(key, content);
    if ((await options.target.get(key))?.equals(content)) safe.push(key);
    else {
      failed.push(key);
      log(`! ${key}: the copy did not match the original`);
    }
  }

  let deleted = 0;
  if (options.apply && options.deleteLegacy) {
    for (const key of safe) {
      await options.legacy.removePrefix(key);
      deleted += 1;
    }
  }
  return { found: keys.size, copied, alreadyThere, failed, deleted, bytes };
}
