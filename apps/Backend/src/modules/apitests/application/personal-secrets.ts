import { z } from 'zod';
import { variableSchema } from '../domain/api-test.js';
import {
  AUTH_SECRET_FIELDS,
  type ApiItem,
  type CollectionSpec,
  type RequestAuth,
  type RuntimeState,
  type Variable,
} from '../engine/types.js';

// Credentials are personal: every workspace member keeps their own values in an encrypted vault
// (api_personal_values) and the shared collection or environment only keeps `{{variable}}`
// references. Each sensitive field has a stable ref:
//   var:<key>                       secret variable (collection or environment)
//   auth:<owner>:<field>            credential field of the collection (owner `collection`),
//                                   a folder or a request auth (owner = item id)
//   proxy:username|password         proxy credentials of the collection settings
//   cert:<index>:key|pfx|passphrase client certificate secrets
// These functions are pure: they never touch the store or the encryption key.

/** Where a personal value belongs. `runtime` holds the user's runtime state of a collection. */
export const PERSONAL_SCOPES = ['collection', 'environment', 'runtime'] as const;
export type PersonalScope = (typeof PERSONAL_SCOPES)[number];

/** Ref of the runtime state inside the `runtime` scope (scope id = collection id). */
export const RUNTIME_REF = 'state';

const REFERENCE = /^\s*(\{\{\s*[$\w.-]+\s*\}\}\s*)+$/;

/** A value made only of `{{variable}}` references is not a credential: it stays shared. */
export const isReference = (value: string) => REFERENCE.test(value);

type Visit = (ref: string, value: string, kind: 'variable' | 'field') => string;

function visitAuth(auth: RequestAuth, owner: string, visit: Visit): RequestAuth {
  const fields = AUTH_SECRET_FIELDS[auth.type] ?? [];
  if (!fields.length) return auth;
  const next: Record<string, unknown> = { ...auth };
  for (const field of fields) {
    const value = next[field];
    if (typeof value !== 'string') continue;
    next[field] = visit(`auth:${owner}:${field}`, value, 'field');
  }
  return next as unknown as RequestAuth;
}

function visitItems(items: readonly ApiItem[], visit: Visit): ApiItem[] {
  return items.map((item) => {
    if (item.type === 'folder') {
      return {
        ...item,
        ...(item.auth ? { auth: visitAuth(item.auth, item.id, visit) } : {}),
        items: visitItems(item.items, visit),
      };
    }
    return { ...item, auth: visitAuth(item.auth, item.id, visit) };
  });
}

function visitVariables(variables: readonly Variable[], visit: Visit): Variable[] {
  return variables.map((variable) =>
    variable.secret
      ? { ...variable, value: visit(`var:${variable.key}`, variable.value, 'variable') }
      : { ...variable },
  );
}

/** Copies the collection, passing every sensitive value through `visit`. */
function walk<T extends CollectionSpec>(collection: T, visit: Visit): T {
  const settings = collection.settings;
  let nextSettings = settings;
  if (settings?.proxy || settings?.clientCertificates) {
    const proxy = settings.proxy;
    nextSettings = {
      ...settings,
      ...(proxy
        ? {
            proxy: {
              ...proxy,
              ...(typeof proxy.username === 'string'
                ? { username: visit('proxy:username', proxy.username, 'field') }
                : {}),
              ...(typeof proxy.password === 'string'
                ? { password: visit('proxy:password', proxy.password, 'field') }
                : {}),
            },
          }
        : {}),
      ...(settings.clientCertificates
        ? {
            clientCertificates: settings.clientCertificates.map((certificate, index) => {
              const next: Record<string, unknown> = { ...certificate };
              for (const field of ['key', 'pfx', 'passphrase'] as const) {
                const value = certificate[field];
                if (typeof value === 'string') {
                  next[field] = visit(`cert:${index}:${field}`, value, 'field');
                }
              }
              return next as unknown as typeof certificate;
            }),
          }
        : {}),
    };
  }
  return {
    ...collection,
    variables: visitVariables(collection.variables, visit),
    auth: visitAuth(collection.auth, 'collection', visit),
    items: visitItems(collection.items, visit),
    ...(nextSettings ? { settings: nextSettings } : {}),
  };
}

export interface Stripped<T> {
  /** What everyone sees: no credential values left. */
  readonly shared: T;
  /** The values typed by the user who saves, to move to their vault. */
  readonly extracted: Map<string, string>;
}

/**
 * Moves every credential value out of the document. Secret variables never keep a value;
 * other fields keep `{{variable}}` references. Empty values are not extracted: they keep the
 * user's current personal value.
 */
export function strip<T extends CollectionSpec>(collection: T): Stripped<T> {
  const extracted = new Map<string, string>();
  const shared = walk(collection, (ref, value, kind) => {
    if (!value) return '';
    if (kind === 'field' && isReference(value)) return value;
    extracted.set(ref, value);
    return '';
  });
  return { shared, extracted };
}

/**
 * Puts personal values back into a shared document (for a run payload). A field that holds a
 * value (a reference, or a literal of an unsaved request) keeps it.
 */
export function fill<T extends CollectionSpec>(
  collection: T,
  values: ReadonlyMap<string, string>,
): T {
  return walk(collection, (ref, value, kind) => {
    if (kind === 'variable') return values.get(ref) ?? '';
    return value || (values.get(ref) ?? '');
  });
}

/** Refs of the fields that take a personal value (references excluded). */
export function refs(collection: CollectionSpec): string[] {
  const found = new Set<string>();
  walk(collection, (ref, value, kind) => {
    if (kind === 'variable' || !isReference(value)) found.add(ref);
    return value;
  });
  return [...found];
}

/** The same rules for the variables of an environment. */
export function stripVariables(variables: readonly Variable[]): Stripped<Variable[]> {
  const extracted = new Map<string, string>();
  const shared = visitVariables(variables, (ref, value) => {
    if (value) extracted.set(ref, value);
    return '';
  });
  return { shared, extracted };
}

export function fillVariables(
  variables: readonly Variable[],
  values: ReadonlyMap<string, string>,
): Variable[] {
  return visitVariables(variables, (ref) => values.get(ref) ?? '');
}

export function variableRefs(variables: readonly Variable[]): string[] {
  return [...new Set(variables.filter((item) => item.secret).map((item) => `var:${item.key}`))];
}

// ---------- runtime state ----------

export const RUNTIME_LIMITS = { variables: 200, cookies: 300, valueChars: 20_000 } as const;

const cookieSchema = z.object({
  name: z.string().max(1_000),
  value: z.string().max(RUNTIME_LIMITS.valueChars),
  domain: z.string().max(500),
  path: z.string().max(2_000),
  expires: z.number().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  hostOnly: z.boolean().optional(),
  sameSite: z.string().max(50).optional(),
});

export const runtimeStateSchema = z.object({
  variables: z.array(variableSchema).max(RUNTIME_LIMITS.variables).default([]),
  cookies: z.array(cookieSchema).max(RUNTIME_LIMITS.cookies).default([]),
});

export const EMPTY_RUNTIME: RuntimeState = { variables: [], cookies: [] };

/**
 * Keeps a runtime state within the limits: what a run reports may be bigger than what a user
 * types, so oversized entries are dropped instead of failing. Null when it is not a state.
 */
export function normalizeRuntime(raw: unknown): RuntimeState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { variables?: unknown; cookies?: unknown };
  const variables = (Array.isArray(value.variables) ? value.variables : [])
    .map((item) => variableSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((item) => item.key.trim() && item.value.length <= RUNTIME_LIMITS.valueChars);
  // The latest value of a name wins.
  const byKey = new Map(variables.map((item) => [item.key, item] as const));
  const cookies = (Array.isArray(value.cookies) ? value.cookies : [])
    .map((item) => cookieSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  return {
    variables: [...byKey.values()].slice(-RUNTIME_LIMITS.variables),
    cookies: cookies.slice(-RUNTIME_LIMITS.cookies),
  };
}
