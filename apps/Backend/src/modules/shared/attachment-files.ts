import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';
import { attachmentMetaKey, readAttachmentMeta, type StoredAttachmentMeta } from './attachment.js';

/**
 * Lifecycle of files stored by the ADK. The browser keeps everything a user pastes or
 * attaches as a local draft and uploads it only when the item is saved; uploads start
 * `pending`. Saving the item claims the files its content references, deleting files it
 * no longer references; deleting the item deletes its files. Pending files that no item
 * claimed (a save that failed or was abandoned) are removed by `sweepPendingFiles`.
 */

const FILE_REFERENCE =
  /\/attachments\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Files of the ADK storage referenced anywhere in the given values (texts, lists...). */
export function referencedFiles(...values: unknown[]): Set<string> {
  const text = JSON.stringify(values);
  return new Set([...text.matchAll(FILE_REFERENCE)].map((match) => match[1]!.toLowerCase()));
}

/** Owner key of an item, e.g. `issue:<id>`. */
export function fileOwner(type: string, id: string): string {
  return `${type}:${id}`;
}

function attachmentPrefix(workspaceId: string, id: string): string {
  return `attachments/${workspaceId}/${id}`;
}

async function writeMeta(store: E2eArtifactStore, workspaceId: string, meta: StoredAttachmentMeta) {
  await store.put(
    attachmentMetaKey(workspaceId, meta.id),
    Buffer.from(JSON.stringify(meta), 'utf8'),
  );
}

export async function deleteFile(store: E2eArtifactStore, workspaceId: string, id: string) {
  await store.removePrefix(attachmentPrefix(workspaceId, id));
}

/** Makes the referenced files permanent and gives them to `owner` when nobody owns them. */
async function claimFiles(
  store: E2eArtifactStore,
  workspaceId: string,
  owner: string,
  ids: Iterable<string>,
) {
  for (const id of ids) {
    const meta = await readAttachmentMeta(store, workspaceId, id);
    if (!meta || (meta.status === 'committed' && meta.owner)) continue;
    await writeMeta(store, workspaceId, {
      ...meta,
      status: 'committed',
      owner: meta.owner ?? owner,
    });
  }
}

/** Deletes the files `owner` holds; files another item owns are kept. */
async function releaseFiles(
  store: E2eArtifactStore,
  workspaceId: string,
  owner: string,
  ids: Iterable<string>,
) {
  for (const id of ids) {
    const meta = await readAttachmentMeta(store, workspaceId, id);
    if (meta?.owner === owner) await deleteFile(store, workspaceId, id);
  }
}

/**
 * Applies a saved change of an item: claims what `next` references and deletes the files
 * `previous` referenced that `next` no longer does. Pass `next` as null when the item was
 * deleted.
 */
export async function syncItemFiles(
  store: E2eArtifactStore | undefined,
  workspaceId: string,
  owner: string,
  previous: unknown,
  next: unknown,
): Promise<void> {
  if (!store) return;
  const before =
    previous === null || previous === undefined ? new Set<string>() : referencedFiles(previous);
  const after = next === null || next === undefined ? new Set<string>() : referencedFiles(next);
  await claimFiles(store, workspaceId, owner, after);
  await releaseFiles(
    store,
    workspaceId,
    owner,
    [...before].filter((id) => !after.has(id)),
  );
}

/** Same as syncItemFiles, logging instead of failing: the item change is already saved. */
export function syncItemFilesSafely(...args: Parameters<typeof syncItemFiles>): Promise<void> {
  return syncItemFiles(...args).catch((error: unknown) =>
    console.error('[Attachments] Could not update the files of', args[2], error),
  );
}

export const PENDING_FILE_TTL_MS = 60 * 60 * 1000;

/** Deletes uploads that no saved item claimed within `maxAgeMs`. Returns how many. */
export async function sweepPendingFiles(
  store: E2eArtifactStore,
  maxAgeMs = PENDING_FILE_TTL_MS,
  now = Date.now(),
): Promise<number> {
  if (!store.listKeys) return 0;
  let removed = 0;
  for (const key of await store.listKeys('attachments')) {
    const match = /^attachments\/([^/]+)\/([0-9a-f-]{36})\/meta\.json$/i.exec(key);
    if (!match) continue;
    const [, workspaceId, id] = match;
    const meta = await readAttachmentMeta(store, workspaceId!, id!);
    if (meta?.status !== 'pending' || now - Date.parse(meta.createdAt) < maxAgeMs) continue;
    await deleteFile(store, workspaceId!, id!);
    removed += 1;
  }
  return removed;
}
