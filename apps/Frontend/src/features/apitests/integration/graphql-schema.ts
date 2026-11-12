// GraphQL schema of a request's server: the introspection request, the schema read from its
// answer, and the field completion of the query editor. No React here.

import type { ApiRequestSpec, RequestResult } from '../api-test-types.js';
import type { CompletionSource, WordCompletion } from './CodeEditor.js';
import { formatMessage, getMessages } from '../../../lib/i18n/index.js';

/** The standard introspection query (as graphql-js `getIntrospectionQuery()`, descriptions on). */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }
    }
  }
}`;

export interface TypeRef {
  readonly kind: string;
  readonly name: string | null;
  readonly ofType: TypeRef | null;
}

export interface SchemaInputValue {
  readonly name: string;
  readonly description?: string | null;
  readonly type: TypeRef;
  readonly defaultValue?: string | null;
}

export interface SchemaField {
  readonly name: string;
  readonly description?: string | null;
  readonly args: readonly SchemaInputValue[];
  readonly type: TypeRef;
  readonly isDeprecated?: boolean;
  readonly deprecationReason?: string | null;
}

export interface SchemaType {
  readonly kind: string;
  readonly name: string;
  readonly description?: string | null;
  readonly fields?: readonly SchemaField[] | null;
  readonly inputFields?: readonly SchemaInputValue[] | null;
  readonly interfaces?: readonly TypeRef[] | null;
  readonly enumValues?:
    readonly { readonly name: string; readonly description?: string | null }[] | null;
  readonly possibleTypes?: readonly TypeRef[] | null;
}

export interface GraphqlSchema {
  readonly queryType: string | null;
  readonly mutationType: string | null;
  readonly subscriptionType: string | null;
  /** By name, the built-in `__` types left out. */
  readonly types: ReadonlyMap<string, SchemaType>;
}

/** A copy of `request` that asks its server for the schema: same URL, headers and auth. */
export function introspectionRequest(request: ApiRequestSpec): ApiRequestSpec {
  return {
    ...request,
    kind: 'graphql',
    method: 'POST',
    graphql: { query: INTROSPECTION_QUERY, variables: '{}', operationName: 'IntrospectionQuery' },
    assertions: [],
    captures: [],
    scripts: undefined,
  };
}

/** Reads the schema from the answer to the introspection query; throws a readable message. */
export function parseIntrospection(result: RequestResult): GraphqlSchema {
  if (result.error) throw new Error(result.error);
  if (result.response?.truncated) throw new Error('truncated');
  let json: unknown;
  try {
    json = JSON.parse(result.response?.bodyPreview ?? '');
  } catch {
    throw new Error(
      formatMessage(getMessages().apiTests.graphqlNotJson, { status: result.status ?? '—' }),
    );
  }
  const body = json as {
    data?: { __schema?: Record<string, unknown> };
    errors?: { message?: string }[];
  };
  const schema = body.data?.__schema as
    | {
        queryType?: { name: string } | null;
        mutationType?: { name: string } | null;
        subscriptionType?: { name: string } | null;
        types?: SchemaType[];
      }
    | undefined;
  if (!schema?.types) {
    throw new Error(body.errors?.[0]?.message ?? `HTTP ${result.status ?? '—'}: no __schema`);
  }
  return {
    queryType: schema.queryType?.name ?? null,
    mutationType: schema.mutationType?.name ?? null,
    subscriptionType: schema.subscriptionType?.name ?? null,
    types: new Map(
      schema.types.filter((type) => !type.name.startsWith('__')).map((type) => [type.name, type]),
    ),
  };
}

/** `[User!]!` */
export function typeLabel(ref: TypeRef): string {
  if (ref.kind === 'NON_NULL' && ref.ofType) return `${typeLabel(ref.ofType)}!`;
  if (ref.kind === 'LIST' && ref.ofType) return `[${typeLabel(ref.ofType)}]`;
  return ref.name ?? '?';
}

/** The type under the lists and non-nulls: `User` for `[User!]!`. */
export function namedType(ref: TypeRef): string {
  return ref.ofType ? namedType(ref.ofType) : (ref.name ?? '');
}

const NAME = /[_A-Za-z][_0-9A-Za-z]*/y;

/**
 * The type whose fields go at `caret`: follows the selection sets (`query {`, `user(id: 1) {`,
 * `... on Admin {`, `fragment F on User {`) from the start of the document. Null outside a
 * selection set, inside arguments, strings or comments.
 */
export function typeAt(schema: GraphqlSchema, text: string, caret: number): string | null {
  const stack: (string | null)[] = [];
  let parens = 0;
  // The last field name, `on` type, or operation keyword seen at this level.
  let pending: { kind: 'field' | 'type' | 'operation'; name: string } | null = null;
  let afterOn = false;
  let index = 0;
  while (index < caret) {
    const char = text[index]!;
    if (char === '#') {
      const end = text.indexOf('\n', index);
      if (end === -1 || end >= caret) return null;
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== '\n')
        end += text[end] === '\\' ? 2 : 1;
      if (end >= caret) return null;
      index = end + 1;
    } else if (char === '(') {
      parens += 1;
      index += 1;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
      index += 1;
    } else if (parens > 0) {
      index += 1;
    } else if (char === '{') {
      const parent = stack.length ? stack[stack.length - 1]! : null;
      let next: string | null = null;
      if (pending?.kind === 'type') next = pending.name;
      else if (pending?.kind === 'operation') next = rootType(schema, pending.name);
      else if (pending?.kind === 'field' && parent) {
        const field = schema.types.get(parent)?.fields?.find((item) => item.name === pending!.name);
        next = field ? namedType(field.type) : null;
      } else if (!stack.length) next = schema.queryType;
      stack.push(next);
      pending = null;
      index += 1;
    } else if (char === '}') {
      stack.pop();
      pending = null;
      index += 1;
    } else if (/[_A-Za-z]/.test(char)) {
      NAME.lastIndex = index;
      const word = NAME.exec(text)![0];
      if (afterOn) pending = { kind: 'type', name: word };
      else if (!stack.length && ['query', 'mutation', 'subscription'].includes(word))
        pending = { kind: 'operation', name: word };
      else if (stack.length && word !== 'on') pending = { kind: 'field', name: word };
      afterOn = word === 'on';
      index += word.length;
    } else {
      // `alias: field` keeps the field; `@directive` names are not fields.
      if (char === '@') {
        NAME.lastIndex = index + 1;
        index += 1 + (NAME.exec(text)?.[0].length ?? 0);
      } else index += 1;
    }
  }
  return parens > 0 || !stack.length ? null : stack[stack.length - 1]!;
}

function rootType(schema: GraphqlSchema, operation: string): string | null {
  if (operation === 'mutation') return schema.mutationType;
  if (operation === 'subscription') return schema.subscriptionType;
  return schema.queryType;
}

/** Field completion for the query editor: the fields of the type at the caret. */
export function fieldCompletions(schema: GraphqlSchema): CompletionSource {
  return (text, caret) => {
    const word = /[_A-Za-z][_0-9A-Za-z]*$/.exec(text.slice(0, caret));
    if (!word) return null;
    const start = caret - word[0].length;
    // Not `$variable`, `@directive` or `...Fragment`.
    if (/[$@.]$/.test(text.slice(0, start))) return null;
    const type = typeAt(schema, text, start);
    const fields = type ? schema.types.get(type)?.fields : null;
    if (!fields) return null;
    const prefix = word[0].toLowerCase();
    const items: WordCompletion[] = fields
      .filter((field) => field.name.toLowerCase().startsWith(prefix) && field.name !== word[0])
      .slice(0, 50)
      .map((field) => ({ label: field.name, detail: typeLabel(field.type) }));
    return { start, items };
  };
}

/** Schemas already fetched, by URL, for this page session. */
export const schemaCache = new Map<string, GraphqlSchema>();
