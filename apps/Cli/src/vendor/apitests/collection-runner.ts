import { executeRequest, scopeOf, type ExecuteOptions } from './http-request.js';
import type {
  ApiItem,
  ApiRequestSpec,
  CollectionRunResult,
  CollectionSpec,
  RequestAuth,
  RequestResult,
  Variable,
} from './types.js';

export interface FlatRequest {
  readonly request: ApiRequestSpec;
  /** Folder names from the root. */
  readonly path: readonly string[];
  /** The auth that applies once `inherit` is resolved through folders and the collection. */
  readonly auth: RequestAuth;
}

/** Every request in run order, with its folder path and effective auth. */
export function flattenRequests(collection: Pick<CollectionSpec, 'auth' | 'items'>): FlatRequest[] {
  const out: FlatRequest[] = [];
  const walk = (items: readonly ApiItem[], path: readonly string[], inherited: RequestAuth) => {
    for (const item of items) {
      if (item.type === 'folder') {
        const auth = item.auth && item.auth.type !== 'inherit' ? item.auth : inherited;
        walk(item.items, [...path, item.name], auth);
      } else {
        out.push({
          request: item,
          path,
          auth: item.auth.type === 'inherit' ? inherited : item.auth,
        });
      }
    }
  };
  walk(
    collection.items,
    [],
    collection.auth.type === 'inherit' ? { type: 'none' } : collection.auth,
  );
  return out;
}

/** Ids of every request inside the given folders or requests (all of them when empty). */
export function selectRequests(
  collection: Pick<CollectionSpec, 'auth' | 'items'>,
  itemIds: readonly string[] = [],
): FlatRequest[] {
  if (!itemIds.length) return flattenRequests(collection);
  const wanted = new Set<string>();
  const mark = (items: readonly ApiItem[], inside: boolean) => {
    for (const item of items) {
      const selected = inside || itemIds.includes(item.id);
      if (item.type === 'folder') mark(item.items, selected);
      else if (selected) wanted.add(item.id);
    }
  };
  mark(collection.items, false);
  return flattenRequests(collection).filter((entry) => wanted.has(entry.request.id));
}

export interface CollectionRunOptions extends Omit<
  ExecuteOptions,
  'auth' | 'path' | 'keepResponse'
> {
  /** Environment variables; they override the collection's own. */
  readonly environment?: readonly Variable[];
  /** Folders or requests to run; empty runs the whole collection. */
  readonly itemIds?: readonly string[];
  /** Stop at the first request that fails. */
  readonly bail?: boolean;
  /** Pause between requests. */
  readonly delayMs?: number;
  readonly onResult?: (result: RequestResult, index: number, total: number) => void | Promise<void>;
}

/**
 * Runs the requests one after the other, sharing variables: a capture of one request (a token,
 * a created id) is available to the next ones, as in a Postman or Bruno collection run.
 */
export async function runCollection(
  collection: CollectionSpec,
  options: CollectionRunOptions = {},
): Promise<CollectionRunResult> {
  const started = performance.now();
  const scope = scopeOf(collection.variables, options.environment ?? []);
  const requests = selectRequests(collection, options.itemIds);
  const results: RequestResult[] = [];
  for (const [index, entry] of requests.entries()) {
    if (options.signal?.aborted) break;
    const result = await executeRequest(entry.request, scope, {
      ...options,
      auth: entry.auth,
      path: entry.path,
      keepResponse: true,
    });
    results.push(result);
    await options.onResult?.(result, index, requests.length);
    if (options.bail && !result.passed) break;
    if (options.delayMs && index < requests.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    durationMs: Math.round(performance.now() - started),
    total: requests.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
