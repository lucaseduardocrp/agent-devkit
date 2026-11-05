// Where an item's inherited settings come from: its folders, nearest first, then the collection.

import type { ApiCollection, ApiFolder, ApiItem, RequestAuth } from '../api-test-types.js';

/** The folders that contain `id`, from the root down; null when it is not in the tree. */
export function folderPath(items: readonly ApiItem[], id: string): ApiFolder[] | null {
  for (const item of items) {
    if (item.id === id) return [];
    if (item.type === 'folder') {
      const inner = folderPath(item.items, id);
      if (inner) return [item, ...inner];
    }
  }
  return null;
}

/** The auth an item with `inherit` gets, and the name of the folder or collection that sets it. */
export function inheritedAuth(
  collection: Pick<ApiCollection, 'name' | 'auth' | 'items'>,
  itemId: string,
): { from: string; auth: RequestAuth } {
  const folders = folderPath(collection.items, itemId) ?? [];
  for (const folder of [...folders].reverse())
    if (folder.auth && folder.auth.type !== 'inherit')
      return { from: folder.name, auth: folder.auth };
  return { from: collection.name, auth: collection.auth };
}
