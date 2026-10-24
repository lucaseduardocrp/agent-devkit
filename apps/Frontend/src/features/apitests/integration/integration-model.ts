// State helpers of the integration tests workbench: the request tree, the open tabs, the
// response history and the code generation. No React here, so the components stay small.

import {
  flattenItems,
  type ApiCollection,
  type ApiItem,
  type ApiRequestSpec,
  type ApiRun,
  type HttpMethod,
  type KeyValue,
  type RequestResult,
} from '../api-test-types.js';

// ---------- look ----------

/** Method colors, as Bruno shows them, taken from the ADK palette. */
export const METHOD_COLOR: Record<HttpMethod, string> = {
  GET: 'text-[var(--text-success)]',
  POST: 'text-[var(--text-accent)]',
  PUT: 'text-[var(--text-warning)]',
  PATCH: 'text-orange-400',
  DELETE: 'text-[var(--text-danger)]',
  HEAD: 'text-[var(--text-pro)]',
  OPTIONS: 'text-teal-400',
};

export const METHOD_SHORT: Partial<Record<HttpMethod, string>> = {
  DELETE: 'DEL',
  OPTIONS: 'OPT',
};

export const STATUS_PHRASES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export const statusLine = (status: number) => `${status} ${STATUS_PHRASES[status] ?? ''}`.trim();

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export const formatDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;

/** The body as JSON when it parses, otherwise as it came. */
export function prettyBody(text: string): { code: string; language: string } {
  try {
    return { code: JSON.stringify(JSON.parse(text), null, 2), language: 'json' };
  } catch {
    return { code: text, language: /^\s*</.test(text) ? 'xml' : 'plaintext' };
  }
}

// ---------- tree ----------

export function mapItems(
  items: readonly ApiItem[],
  id: string,
  fn: (item: ApiItem) => ApiItem,
): ApiItem[] {
  return items.map((item) =>
    item.id === id
      ? fn(item)
      : item.type === 'folder'
        ? { ...item, items: mapItems(item.items, id, fn) }
        : item,
  );
}

export function removeItem(items: readonly ApiItem[], id: string): ApiItem[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) =>
      item.type === 'folder' ? { ...item, items: removeItem(item.items, id) } : item,
    );
}

export function addItem(
  items: readonly ApiItem[],
  folderId: string | null,
  item: ApiItem,
): ApiItem[] {
  if (!folderId) return [...items, item];
  return mapItems(items, folderId, (folder) =>
    folder.type === 'folder' ? { ...folder, items: [...folder.items, item] } : folder,
  );
}

/** Puts the copy right after the original, in the same folder. */
export function insertAfter(items: readonly ApiItem[], id: string, item: ApiItem): ApiItem[] {
  const index = items.findIndex((entry) => entry.id === id);
  if (index >= 0) return [...items.slice(0, index + 1), item, ...items.slice(index + 1)];
  return items.map((entry) =>
    entry.type === 'folder' ? { ...entry, items: insertAfter(entry.items, id, item) } : entry,
  );
}

export function findItem(items: readonly ApiItem[], id: string): ApiItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.type === 'folder') {
      const found = findItem(item.items, id);
      if (found) return found;
    }
  }
  return null;
}

export function findRequest(items: readonly ApiItem[], id: string): ApiRequestSpec | null {
  const item = findItem(items, id);
  return item?.type === 'request' ? item : null;
}

/** Deep copy with new ids, so the clone can be edited and run on its own. */
export function cloneItem(item: ApiItem, name: string): ApiItem {
  const renew = (entry: ApiItem): ApiItem =>
    entry.type === 'folder'
      ? { ...entry, id: crypto.randomUUID(), items: entry.items.map(renew) }
      : {
          ...entry,
          id: crypto.randomUUID(),
          assertions: entry.assertions.map((assertion) => ({
            ...assertion,
            id: crypto.randomUUID(),
          })),
        };
  return { ...renew(item), name };
}

export function itemMatches(item: ApiItem, filter: string): boolean {
  if (!filter) return true;
  const text = filter.toLowerCase();
  if (item.type === 'folder')
    return (
      item.name.toLowerCase().includes(text) ||
      item.items.some((child) => itemMatches(child, filter))
    );
  return `${item.method} ${item.name} ${item.url}`.toLowerCase().includes(text);
}

export const requestIds = (items: readonly ApiItem[]) =>
  flattenItems(items).map((entry) => entry.request.id);

// ---------- tabs ----------

export type WorkbenchTab =
  | { readonly kind: 'request'; readonly collectionId: string; readonly requestId: string }
  | { readonly kind: 'settings'; readonly collectionId: string }
  | { readonly kind: 'runner'; readonly collectionId: string }
  | { readonly kind: 'environments' };

export const tabKey = (tab: WorkbenchTab) =>
  tab.kind === 'request'
    ? `request:${tab.requestId}`
    : tab.kind === 'environments'
      ? 'environments'
      : `${tab.kind}:${tab.collectionId}`;

/** The collection a tab belongs to; environments belong to the workspace. */
export const tabCollection = (tab: WorkbenchTab) =>
  tab.kind === 'environments' ? null : tab.collectionId;

// ---------- path params ----------

/** Same rule as the engine: `/:name` segments; a port never matches, it starts with a digit. */
const PATH_PARAM = /\/:([A-Za-z_][\w-]*)/g;

export const pathParamNames = (url: string) => [
  ...new Set([...url.split('?')[0]!.matchAll(PATH_PARAM)].map((match) => match[1]!)),
];

/** The params follow the URL: new `:name` segments get a row, removed ones go away. */
export function syncPathParams(url: string, current: readonly KeyValue[] = []): KeyValue[] {
  return pathParamNames(url).map(
    (name) => current.find((param) => param.key === name) ?? { key: name, value: '' },
  );
}

export function fillPathParams(url: string, params: readonly KeyValue[] = []): string {
  const values = new Map(
    params.filter((param) => param.enabled !== false).map((param) => [param.key, param.value]),
  );
  return url.replace(PATH_PARAM, (segment, name: string) =>
    values.has(name) ? `/${values.get(name)!}` : segment,
  );
}

// ---------- responses ----------

/** One send of a request: what came back, or why nothing did. */
export interface ResponseEntry {
  readonly runId: string;
  readonly at: number;
  readonly result: RequestResult | null;
  readonly error: string | null;
}

/** A send still waiting for the worker or the devkit runner. */
export interface PendingSend {
  readonly runId: string;
  readonly startedAt: number;
  readonly status: ApiRun['status'];
}

export const HISTORY_LIMIT = 20;

// ---------- layout ----------

export type PaneLayout = 'horizontal' | 'vertical';
const LAYOUT_KEY = 'adk.integrationTests.layout';

export function readLayout(): PaneLayout {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === 'vertical' ? 'vertical' : 'horizontal';
  } catch {
    return 'horizontal';
  }
}

export function writeLayout(layout: PaneLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Private windows may block storage: the layout just is not remembered.
  }
}

// ---------- code generation ----------

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The request as a cURL command. Variables stay as {{name}}: they are resolved when sent. */
export function toCurl(request: ApiRequestSpec, collection: Pick<ApiCollection, 'auth'>): string {
  const query = request.query.filter((row) => row.enabled !== false && row.key);
  const path = fillPathParams(request.url, request.pathParams);
  const url = query.length
    ? `${path}${path.includes('?') ? '&' : '?'}${query.map((row) => `${row.key}=${row.value}`).join('&')}`
    : path;
  const lines = [`curl -X ${request.method} ${shellQuote(url)}`];
  const auth = request.auth.type === 'inherit' ? collection.auth : request.auth;
  if (auth.type === 'bearer') lines.push(`-H ${shellQuote(`Authorization: Bearer ${auth.token}`)}`);
  if (auth.type === 'basic') lines.push(`-u ${shellQuote(`${auth.username}:${auth.password}`)}`);
  if (auth.type === 'apikey' && auth.in === 'header')
    lines.push(`-H ${shellQuote(`${auth.key}: ${auth.value}`)}`);
  for (const header of request.headers.filter((row) => row.enabled !== false && row.key))
    lines.push(`-H ${shellQuote(`${header.key}: ${header.value}`)}`);
  const body = request.body;
  if (body.mode === 'json' || body.mode === 'text' || body.mode === 'xml') {
    const type = { json: 'application/json', text: 'text/plain', xml: 'application/xml' }[
      body.mode
    ];
    if (!request.headers.some((row) => row.key.toLowerCase() === 'content-type'))
      lines.push(`-H ${shellQuote(`Content-Type: ${type}`)}`);
    if (body.content) lines.push(`--data-raw ${shellQuote(body.content)}`);
  } else if (body.mode === 'urlencoded') {
    for (const field of body.fields.filter((row) => row.enabled !== false && row.key))
      lines.push(`--data-urlencode ${shellQuote(`${field.key}=${field.value}`)}`);
  } else if (body.mode === 'form') {
    for (const field of body.fields.filter((row) => row.enabled !== false && row.key))
      lines.push(`-F ${shellQuote(`${field.key}=${field.value}`)}`);
  }
  return lines.join(' \\\n  ');
}

// ---------- query in the URL ----------

const enabledQuery = (query: readonly KeyValue[]) => query.filter((row) => row.enabled !== false);

/** The URL as shown in the URL bar: the path plus the enabled query params, as in Bruno. */
export function composeUrl(url: string, query: readonly KeyValue[]): string {
  const rows = enabledQuery(query).filter((row) => row.key || row.value);
  if (!rows.length) return url;
  const pairs = rows.map((row) => (row.value ? `${row.key}=${row.value}` : row.key)).join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${pairs}`;
}

/**
 * Reads what was typed in the URL bar back into the path and the query rows. Values stay as
 * typed (no decoding) so `{{variables}}` survive; disabled rows are not in the URL and are kept.
 */
export function splitUrl(
  text: string,
  previous: readonly KeyValue[],
): { url: string; query: KeyValue[] } {
  const index = text.indexOf('?');
  if (index < 0) return { url: text, query: previous.filter((row) => row.enabled === false) };
  const query = text
    .slice(index + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const equals = pair.indexOf('=');
      return equals < 0
        ? { key: pair, value: '' }
        : { key: pair.slice(0, equals), value: pair.slice(equals + 1) };
    });
  return {
    url: text.slice(0, index),
    query: [...query, ...previous.filter((row) => row.enabled === false)],
  };
}

/** Whether `text` means the same request as `url` + `query`, typed differently (`?a` vs `?a=`). */
export function sameUrl(text: string, url: string, query: readonly KeyValue[]): boolean {
  const parsed = splitUrl(text, query);
  const a = enabledQuery(parsed.query).filter((row) => row.key || row.value);
  const b = enabledQuery(query).filter((row) => row.key || row.value);
  return (
    parsed.url === url &&
    a.length === b.length &&
    a.every((row, index) => row.key === b[index]!.key && row.value === b[index]!.value)
  );
}
