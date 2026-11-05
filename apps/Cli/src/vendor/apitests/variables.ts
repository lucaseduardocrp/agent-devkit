import { resolveDynamicValue } from './dynamic-values.js';
import type { KeyValue, Variable } from './types.js';

const MASK = '••••••';

export interface ScopeEntry {
  readonly value: string;
  readonly secret: boolean;
}

/** Values of a run by name. Captures and scripts write into it as requests run. */
export interface VariableScope {
  get(name: string): ScopeEntry | undefined;
  set(name: string, entry: ScopeEntry): unknown;
  values(): Iterable<ScopeEntry>;
}

export function scopeOf(...lists: readonly (readonly Variable[])[]): Map<string, ScopeEntry> {
  const scope = new Map<string, ScopeEntry>();
  for (const list of lists) {
    for (const variable of list) {
      if (variable.enabled === false || !variable.key.trim()) continue;
      scope.set(variable.key.trim(), { value: variable.value, secret: Boolean(variable.secret) });
    }
  }
  return scope;
}

/**
 * Replaces `{{name}}` with the variable value. Names that start with `$` are mock values, a new one
 * every time (`{{$guid}}`, `{{$randomFullName}}`, `{{$randomEmail}}`...; see dynamic-values.ts).
 * Unknown names are left as they are, so a missing variable is visible in the result.
 */
export function interpolate(text: string, scope: Pick<VariableScope, 'get'>): string {
  return text.replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (match, name: string) => {
    return resolveDynamicValue(name) ?? scope.get(name)?.value ?? match;
  });
}

/** Hides every secret value of the scope, and the `extra` values, inside `text`. */
export function maskSecrets(
  text: string,
  scope: Pick<VariableScope, 'values'>,
  extra: readonly string[] = [],
): string {
  let masked = text;
  const hidden = [
    ...[...scope.values()].filter((entry) => entry.secret).map((entry) => entry.value),
    ...extra,
  ];
  // Longest first, so a secret that contains another one is hidden whole.
  for (const value of hidden.sort((a, b) => b.length - a.length)) {
    if (value.length >= 4) masked = masked.split(value).join(MASK);
  }
  return masked;
}

export const MASKED = MASK;

/** The layers of a collection run, from the weakest to the strongest. */
export const LAYERS = [
  'collection',
  'environment',
  'folder',
  'request',
  'data',
  'runtime',
] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * The variables of a run in layers, as Bruno resolves them: runtime (captures, `adk.setVar`) >
 * iteration data > request vars > folder vars > environment > collection. Writes through `set`
 * (captures) go to the runtime layer.
 */
export class LayeredScope implements VariableScope {
  private readonly layers = new Map<Layer, Map<string, ScopeEntry>>(
    LAYERS.map((layer) => [layer, new Map()]),
  );

  constructor(initial: Partial<Record<Layer, readonly Variable[]>> = {}) {
    for (const layer of LAYERS) {
      const list = initial[layer];
      if (list) this.layers.set(layer, scopeOf(list));
    }
  }

  layer(layer: Layer): Map<string, ScopeEntry> {
    return this.layers.get(layer)!;
  }

  get(name: string): ScopeEntry | undefined {
    for (let index = LAYERS.length - 1; index >= 0; index -= 1) {
      const found = this.layers.get(LAYERS[index]!)!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  set(name: string, entry: ScopeEntry): void {
    this.setIn('runtime', name, entry.value, entry.secret);
  }

  /** Keeps the secret mark a name has anywhere, so a captured token stays masked. */
  setIn(layer: Layer, name: string, value: string, secret = false): void {
    this.layer(layer).set(name, { value, secret: secret || this.isSecret(name) });
  }

  isSecret(name: string): boolean {
    for (const map of this.layers.values()) if (map.get(name)?.secret) return true;
    return false;
  }

  *values(): Iterable<ScopeEntry> {
    for (const map of this.layers.values()) yield* map.values();
  }

  /**
   * Replaces a layer with `values` (key → value), keeping the secret marks. Values of folder and
   * request vars may refer to other variables; they are resolved when set.
   */
  replace(layer: Layer, values: Readonly<Record<string, string>>): void {
    const next = new Map<string, ScopeEntry>();
    for (const [name, value] of Object.entries(values)) {
      next.set(name, { value, secret: this.isSecret(name) });
    }
    this.layers.set(layer, next);
  }

  /** Sets `layer` from editor rows, resolving `{{references}}` against what is already set. */
  assign(layer: Layer, rows: readonly KeyValue[]): void {
    this.layers.set(layer, new Map());
    for (const row of rows) {
      if (row.enabled === false || !row.key.trim()) continue;
      this.setIn(layer, row.key.trim(), interpolate(row.value, this));
    }
  }

  record(layer: Layer): Record<string, string> {
    return Object.fromEntries([...this.layer(layer)].map(([name, entry]) => [name, entry.value]));
  }

  variables(layer: Layer): Variable[] {
    return [...this.layer(layer)].map(([key, entry]) => ({
      key,
      value: entry.value,
      ...(entry.secret ? { secret: true } : {}),
    }));
  }
}
