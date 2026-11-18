import { randomUUID } from 'node:crypto';
import type { CollectionInput } from '../domain/api-test.js';
import type {
  ApiFolder,
  ApiItem,
  ApiRequestSpec,
  HttpMethod,
  KeyValue,
  RequestAuth,
} from '../engine/types.js';

// OpenAPI 3.x and Swagger 2.0 (JSON or YAML, parsed by the caller): one request per operation,
// grouped in folders by tag, with example bodies, the security scheme as collection auth and an
// assertion on the documented success status.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function isOpenApi(document: unknown): boolean {
  return (
    isObject(document) &&
    (typeof document['openapi'] === 'string' || typeof document['swagger'] === 'string')
  );
}

function resolve(document: Json, value: unknown, depth = 0): unknown {
  if (!isObject(value) || typeof value['$ref'] !== 'string' || depth > 20) return value;
  const ref = value['$ref'];
  if (!ref.startsWith('#/')) return {};
  let current: unknown = document;
  for (const part of ref.slice(2).split('/')) {
    current = isObject(current) ? current[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return resolve(document, current, depth + 1);
}

/** A plausible example value for a JSON schema, preferring the schema's own examples. */
export function sampleFor(
  document: Json,
  schemaValue: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): unknown {
  const schema = resolve(document, schemaValue);
  if (!isObject(schema) || depth > 8 || seen.has(schema)) return null;
  if (schema['example'] !== undefined) return schema['example'];
  if (Array.isArray(schema['examples']) && schema['examples'].length) return schema['examples'][0];
  if (schema['default'] !== undefined) return schema['default'];
  if (Array.isArray(schema['enum']) && schema['enum'].length) return schema['enum'][0];
  const next = new Set(seen).add(schema);
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    const options = schema[key];
    if (Array.isArray(options) && options.length) {
      if (key !== 'allOf') return sampleFor(document, options[0], depth + 1, next);
      return Object.assign(
        {},
        ...options.map((option) => {
          const value = sampleFor(document, option, depth + 1, next);
          return isObject(value) ? value : {};
        }),
      ) as unknown;
    }
  }
  const type = Array.isArray(schema['type']) ? str(schema['type'][0]) : str(schema['type']);
  if (type === 'object' || isObject(schema['properties'])) {
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        sampleFor(document, value, depth + 1, next),
      ]),
    );
  }
  if (type === 'array') return [sampleFor(document, schema['items'], depth + 1, next)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  const format = str(schema['format']);
  if (format === 'date-time') return '2026-01-01T00:00:00Z';
  if (format === 'date') return '2026-01-01';
  if (format === 'email') return 'user@example.com';
  if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';
  return type === 'string' ? 'string' : null;
}

function securityAuth(document: Json): RequestAuth {
  const schemes =
    isObject(document['components']) && isObject(document['components']['securitySchemes'])
      ? document['components']['securitySchemes']
      : isObject(document['securityDefinitions'])
        ? document['securityDefinitions']
        : {};
  const required = Array.isArray(document['security']) ? document['security'] : [];
  const names = required.flatMap((entry) => (isObject(entry) ? Object.keys(entry) : []));
  const name = names.find((candidate) => candidate in schemes) ?? Object.keys(schemes)[0];
  const scheme = name ? resolve(document, schemes[name]) : undefined;
  if (!isObject(scheme)) return { type: 'none' };
  const type = str(scheme['type']).toLowerCase();
  const httpScheme = str(scheme['scheme']).toLowerCase();
  if (
    (type === 'http' && httpScheme === 'bearer') ||
    type === 'oauth2' ||
    type === 'openidconnect'
  ) {
    return { type: 'bearer', token: '{{token}}' };
  }
  if ((type === 'http' && httpScheme === 'basic') || type === 'basic') {
    return { type: 'basic', username: '{{username}}', password: '{{password}}' };
  }
  if (type === 'apikey') {
    return {
      type: 'apikey',
      key: str(scheme['name']) || 'X-API-Key',
      value: '{{apiKey}}',
      in: scheme['in'] === 'query' ? 'query' : 'header',
    };
  }
  return { type: 'none' };
}

function baseUrl(document: Json): string {
  if (Array.isArray(document['servers']) && isObject(document['servers'][0])) {
    const server = document['servers'][0];
    let url = str(server['url']);
    const variables = isObject(server['variables']) ? server['variables'] : {};
    for (const [key, value] of Object.entries(variables)) {
      url = url.replace(`{${key}}`, isObject(value) ? str(value['default']) : '');
    }
    return url.replace(/\/+$/, '');
  }
  if (typeof document['host'] === 'string') {
    const scheme = Array.isArray(document['schemes']) ? str(document['schemes'][0]) : 'https';
    return `${scheme}://${document['host']}${str(document['basePath'])}`.replace(/\/+$/, '');
  }
  return 'http://localhost';
}

export function importOpenApi(document: Json): CollectionInput {
  const info = isObject(document['info']) ? document['info'] : {};
  const paths = isObject(document['paths']) ? document['paths'] : {};
  const folders = new Map<string, ApiFolder & { items: ApiItem[] }>();
  const loose: ApiItem[] = [];
  const pathVariables = new Map<string, string>();
  const auth = securityAuth(document);

  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = resolve(document, pathItemValue);
    if (!isObject(pathItem)) continue;
    const shared = Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : [];
    for (const method of METHODS) {
      const operation = pathItem[method.toLowerCase()];
      if (!isObject(operation)) continue;
      const parameters = [
        ...(shared as unknown[]),
        ...((Array.isArray(operation['parameters']) ? operation['parameters'] : []) as unknown[]),
      ]
        .map((parameter) => resolve(document, parameter))
        .filter(isObject);
      const example = (parameter: Json) => {
        const value =
          parameter['example'] ??
          sampleFor(document, parameter['schema'] ?? { type: str(parameter['type']) || 'string' });
        return value === null || value === undefined
          ? ''
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      };
      const query: KeyValue[] = parameters
        .filter((parameter) => parameter['in'] === 'query')
        .map((parameter) => ({
          key: str(parameter['name']),
          value: example(parameter),
          ...(parameter['required'] ? {} : { enabled: false }),
        }));
      const headers: KeyValue[] = parameters
        .filter((parameter) => parameter['in'] === 'header')
        .map((parameter) => ({ key: str(parameter['name']), value: example(parameter) }));
      for (const parameter of parameters.filter((p) => p['in'] === 'path')) {
        if (!pathVariables.has(str(parameter['name'])))
          pathVariables.set(str(parameter['name']), example(parameter));
      }

      let body: ApiRequestSpec['body'] = { mode: 'none' };
      const requestBody = resolve(document, operation['requestBody']);
      const content =
        isObject(requestBody) && isObject(requestBody['content']) ? requestBody['content'] : {};
      const bodyParameter = parameters.find((parameter) => parameter['in'] === 'body');
      const json = Object.entries(content).find(([type]) => type.includes('json'));
      if (json && isObject(json[1])) {
        const media = json[1];
        const named = isObject(media['examples']) ? Object.values(media['examples'])[0] : undefined;
        const value = media['example'] ?? (isObject(named) ? resolve(document, named) : undefined);
        const sample =
          isObject(value) && 'value' in value
            ? value['value']
            : (value ?? sampleFor(document, media['schema']));
        body = { mode: 'json', content: JSON.stringify(sample, null, 2) };
      } else if (bodyParameter) {
        body = {
          mode: 'json',
          content: JSON.stringify(sampleFor(document, bodyParameter['schema']), null, 2),
        };
      } else if (Object.keys(content).some((type) => type.includes('x-www-form-urlencoded'))) {
        const schema = resolve(
          document,
          (content['application/x-www-form-urlencoded'] as Json | undefined)?.['schema'],
        );
        const properties =
          isObject(schema) && isObject(schema['properties'])
            ? Object.keys(schema['properties'])
            : [];
        body = { mode: 'urlencoded', fields: properties.map((key) => ({ key, value: '' })) };
      }

      const responses = isObject(operation['responses']) ? Object.keys(operation['responses']) : [];
      const success = responses.find((code) => /^2\d\d$/.test(code));
      const operationSecurity = Array.isArray(operation['security'])
        ? operation['security']
        : undefined;
      const request: ApiRequestSpec = {
        id: randomUUID(),
        type: 'request',
        name: str(operation['summary']) || str(operation['operationId']) || `${method} ${path}`,
        ...(str(operation['description']) ? { description: str(operation['description']) } : {}),
        method,
        url: `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`,
        headers,
        query,
        body,
        // `security: []` on an operation means it is public.
        auth:
          operationSecurity && operationSecurity.length === 0
            ? { type: 'none' }
            : { type: 'inherit' },
        assertions: success
          ? [{ id: randomUUID(), source: 'status', operator: 'eq', expected: success }]
          : [],
        captures: [],
      };
      const tag =
        Array.isArray(operation['tags']) && operation['tags'].length
          ? str(operation['tags'][0])
          : '';
      if (!tag) {
        loose.push(request);
        continue;
      }
      if (!folders.has(tag))
        folders.set(tag, { id: randomUUID(), type: 'folder', name: tag, items: [] });
      folders.get(tag)!.items.push(request);
    }
  }

  const credentials =
    auth.type === 'bearer'
      ? ['token']
      : auth.type === 'basic'
        ? ['username', 'password']
        : auth.type === 'apikey'
          ? ['apiKey']
          : [];
  return {
    name: str(info['title']) || 'OpenAPI',
    ...(str(info['description']) ? { description: str(info['description']) } : {}),
    variables: [
      { key: 'baseUrl', value: baseUrl(document) },
      ...[...pathVariables].map(([key, value]) => ({ key, value })),
      ...credentials.map((key) => ({ key, value: '', secret: true })),
    ],
    auth,
    items: [...folders.values(), ...loose],
  };
}
