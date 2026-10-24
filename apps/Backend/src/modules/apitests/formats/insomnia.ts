import { randomUUID } from 'node:crypto';
import type { CollectionInput } from '../domain/api-test.js';
import type { ApiItem, HttpMethod, KeyValue, RequestAuth, RequestBody } from '../engine/types.js';
import { HTTP_METHODS } from '../engine/types.js';

// Insomnia export format v4 (`__export_format: 4`), still imported by current Insomnia releases.
// Insomnia writes variables as `{{ _.name }}`; ADK, Postman and Bruno use `{{name}}`. Insomnia v4
// has no declarative assertions, so they are listed in the request description on export.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function isInsomniaExport(document: unknown): boolean {
  return (
    isObject(document) && document['_type'] === 'export' && Array.isArray(document['resources'])
  );
}

/** `{{ _.base_url }}` → `{{base_url}}`. */
const fromInsomnia = (text: string) => text.replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}');
/** `{{base_url}}` → `{{ _.base_url }}`; dynamic helpers (`{{$guid}}`) stay as they are. */
const toInsomnia = (text: string) => text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{{ _.$1 }}');

function pairsFrom(value: unknown, key = 'name'): KeyValue[] {
  return list(value)
    .filter(isObject)
    .map((entry) => ({
      key: fromInsomnia(str(entry[key])),
      value: fromInsomnia(str(entry['value'])),
      ...(entry['disabled'] ? { enabled: false } : {}),
    }));
}

function authFrom(value: unknown): RequestAuth {
  if (!isObject(value) || !value['type'] || value['disabled']) return { type: 'inherit' };
  switch (str(value['type'])) {
    case 'bearer':
      return { type: 'bearer', token: fromInsomnia(str(value['token'])) };
    case 'basic':
      return {
        type: 'basic',
        username: fromInsomnia(str(value['username'])),
        password: fromInsomnia(str(value['password'])),
      };
    case 'apikey':
      return {
        type: 'apikey',
        key: str(value['key']) || 'X-API-Key',
        value: fromInsomnia(str(value['value'])),
        in: value['addTo'] === 'queryParams' ? 'query' : 'header',
      };
    case 'none':
      return { type: 'none' };
    default:
      return { type: 'inherit' };
  }
}

function bodyFrom(value: unknown): RequestBody {
  if (!isObject(value)) return { mode: 'none' };
  const mimeType = str(value['mimeType']);
  if (mimeType === 'application/x-www-form-urlencoded')
    return { mode: 'urlencoded', fields: pairsFrom(value['params']) };
  if (mimeType === 'multipart/form-data')
    return { mode: 'form', fields: pairsFrom(value['params']) };
  if (value['text'] === undefined) return { mode: 'none' };
  const mode = mimeType.includes('json') ? 'json' : mimeType.includes('xml') ? 'xml' : 'text';
  return { mode, content: fromInsomnia(str(value['text'])) };
}

export function importInsomnia(document: Json): CollectionInput {
  const resources = list(document['resources']).filter(isObject);
  const workspace = resources.find((resource) => resource['_type'] === 'workspace');
  const childrenOf = (parentId: unknown): ApiItem[] =>
    resources
      .filter((resource) => resource['parentId'] === parentId)
      .sort((a, b) => Number(a['metaSortKey'] ?? 0) - Number(b['metaSortKey'] ?? 0))
      .flatMap((resource): ApiItem[] => {
        if (resource['_type'] === 'request_group') {
          const auth = authFrom(resource['authentication']);
          return [
            {
              id: randomUUID(),
              type: 'folder',
              name: str(resource['name']) || 'Folder',
              ...(str(resource['description'])
                ? { description: str(resource['description']) }
                : {}),
              ...(auth.type !== 'inherit' ? { auth } : {}),
              items: childrenOf(resource['_id']),
            },
          ];
        }
        if (resource['_type'] !== 'request') return [];
        const method = str(resource['method']).toUpperCase();
        return [
          {
            id: randomUUID(),
            type: 'request',
            name: str(resource['name']) || 'Request',
            ...(str(resource['description']) ? { description: str(resource['description']) } : {}),
            method: (HTTP_METHODS as readonly string[]).includes(method)
              ? (method as HttpMethod)
              : 'GET',
            url: fromInsomnia(str(resource['url'])),
            headers: pairsFrom(resource['headers']),
            query: pairsFrom(resource['parameters']),
            body: bodyFrom(resource['body']),
            auth: authFrom(resource['authentication']),
            assertions: [],
            captures: [],
          },
        ];
      });
  // Variables come from the base environment (the one directly under the workspace).
  const environment = resources.find(
    (resource) =>
      resource['_type'] === 'environment' && resource['parentId'] === workspace?.['_id'],
  );
  const data = isObject(environment?.['data']) ? environment['data'] : {};
  return {
    name: str(workspace?.['name']) || 'Insomnia collection',
    ...(str(workspace?.['description']) ? { description: str(workspace?.['description']) } : {}),
    variables: Object.entries(data).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? fromInsomnia(value) : JSON.stringify(value),
    })),
    auth: { type: 'none' },
    items: childrenOf(workspace?.['_id'] ?? null),
  };
}

function authTo(auth: RequestAuth | undefined): Json {
  switch (auth?.type) {
    case 'bearer':
      return { type: 'bearer', token: toInsomnia(auth.token) };
    case 'basic':
      return {
        type: 'basic',
        username: toInsomnia(auth.username),
        password: toInsomnia(auth.password),
      };
    case 'apikey':
      return {
        type: 'apikey',
        key: auth.key,
        value: toInsomnia(auth.value),
        addTo: auth.in === 'query' ? 'queryParams' : 'header',
      };
    case 'none':
      return { type: 'none' };
    default:
      return {};
  }
}

function bodyTo(body: RequestBody): Json {
  switch (body.mode) {
    case 'none':
      return {};
    case 'json':
      return { mimeType: 'application/json', text: toInsomnia(body.content) };
    case 'xml':
      return { mimeType: 'application/xml', text: toInsomnia(body.content) };
    case 'text':
      return { mimeType: 'text/plain', text: toInsomnia(body.content) };
    case 'urlencoded':
    case 'form':
      return {
        mimeType:
          body.mode === 'form' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
        params: body.fields.map((f) => ({
          name: f.key,
          value: toInsomnia(f.value),
          disabled: f.enabled === false,
        })),
      };
  }
}

export function exportInsomnia(collection: CollectionInput): Json {
  const workspaceId = `wrk_${randomUUID().replace(/-/g, '')}`;
  const resources: Json[] = [
    {
      _id: workspaceId,
      _type: 'workspace',
      parentId: null,
      name: collection.name,
      description: collection.description ?? '',
      scope: 'collection',
    },
    {
      _id: `env_${randomUUID().replace(/-/g, '')}`,
      _type: 'environment',
      parentId: workspaceId,
      name: 'Base Environment',
      data: Object.fromEntries(
        collection.variables
          .filter((variable) => variable.enabled !== false)
          .map((variable) => [variable.key, variable.secret ? '' : variable.value]),
      ),
    },
  ];
  let sort = 0;
  const add = (items: readonly ApiItem[], parentId: string, inherited: RequestAuth) => {
    for (const item of items) {
      sort += 1;
      const id = `${item.type === 'folder' ? 'fld' : 'req'}_${randomUUID().replace(/-/g, '')}`;
      if (item.type === 'folder') {
        resources.push({
          _id: id,
          _type: 'request_group',
          parentId,
          name: item.name,
          description: item.description ?? '',
          metaSortKey: sort,
          ...(item.auth && item.auth.type !== 'inherit'
            ? { authentication: authTo(item.auth) }
            : {}),
        });
        add(item.items, id, item.auth && item.auth.type !== 'inherit' ? item.auth : inherited);
        continue;
      }
      const checks = item.assertions.map(
        (a) => `- ${[a.source, a.path, a.operator, a.expected].filter(Boolean).join(' ')}`,
      );
      const captures = item.captures.map(
        (c) => `- ${c.variable} ← ${c.source}${c.path ? ` ${c.path}` : ''}`,
      );
      const description = [
        item.description ?? '',
        checks.length ? `Checks (ADK):\n${checks.join('\n')}` : '',
        captures.length ? `Captures (ADK):\n${captures.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      resources.push({
        _id: id,
        _type: 'request',
        parentId,
        name: item.name,
        description,
        method: item.method,
        url: toInsomnia(item.url),
        headers: item.headers.map((h) => ({
          name: h.key,
          value: toInsomnia(h.value),
          disabled: h.enabled === false,
        })),
        parameters: item.query.map((q) => ({
          name: q.key,
          value: toInsomnia(q.value),
          disabled: q.enabled === false,
        })),
        body: bodyTo(item.body),
        // Insomnia v4 has no auth inheritance: the effective auth is written on each request.
        authentication: authTo(item.auth.type === 'inherit' ? inherited : item.auth),
        metaSortKey: sort,
      });
    }
  };
  add(collection.items, workspaceId, collection.auth);
  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'adk',
    resources,
  };
}
