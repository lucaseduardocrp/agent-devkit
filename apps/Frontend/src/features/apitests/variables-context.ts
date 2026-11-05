import { createContext } from 'react';
import type { ApiCollection, ApiEnvironment, ApiMockValue, Variable } from './api-test-types.js';
import { flattenItems } from './api-test-types.js';

export type VariableSource = 'runtime' | 'environment' | 'collection' | 'capture' | 'dynamic';

/** A variable the `{{` autocomplete offers, with where it comes from. */
export interface VariableSuggestion {
  readonly name: string;
  readonly source: VariableSource;
  readonly value?: string;
  readonly secret?: boolean;
}

/**
 * Variables known where the fields are. Fields outside a provider (overload tests, dialogs)
 * behave as plain inputs.
 */
export const VariablesContext = createContext<readonly VariableSuggestion[] | null>(null);

/** What the engine always generates; the full list of mock values comes from the API. */
const BASE_MOCKS: readonly ApiMockValue[] = [
  '$guid',
  '$timestamp',
  '$isoTimestamp',
  '$randomInt',
].map((name) => ({ name, group: 'ids', sample: '' }));

/**
 * Runtime variables (the user's captures and script values) first, then the environment, as
 * they override the collection when sending. `mocks` are the generated
 * values (`{{$randomFullName}}`...), each shown with a sample of what it produces.
 */
export function variableSuggestions(
  collection: Pick<ApiCollection, 'variables' | 'items'> | null,
  environment: Pick<ApiEnvironment, 'variables'> | null,
  mocks: readonly ApiMockValue[] | null = null,
  runtime: readonly Variable[] = [],
): VariableSuggestion[] {
  const seen = new Set<string>();
  const list: VariableSuggestion[] = [];
  const add = (suggestion: VariableSuggestion) => {
    if (!suggestion.name || seen.has(suggestion.name)) return;
    seen.add(suggestion.name);
    list.push(suggestion);
  };
  for (const variable of runtime)
    if (variable.enabled !== false)
      add({ name: variable.key, source: 'runtime', value: variable.value });
  for (const variable of environment?.variables ?? [])
    if (variable.enabled !== false)
      add({
        name: variable.key,
        source: 'environment',
        value: variable.value,
        secret: variable.secret,
      });
  for (const variable of collection?.variables ?? [])
    if (variable.enabled !== false)
      add({
        name: variable.key,
        source: 'collection',
        value: variable.value,
        secret: variable.secret,
      });
  for (const { request } of flattenItems(collection?.items ?? []))
    for (const capture of request.captures) add({ name: capture.variable, source: 'capture' });
  for (const { name, sample } of mocks?.length ? mocks : BASE_MOCKS) {
    add({ name, source: 'dynamic', ...(sample ? { value: sample } : {}) });
  }
  return list;
}
