import { describe, expect, it } from 'vitest';
import { importOpenApi, isOpenApi, sampleFor } from '../src/modules/apitests/formats/openapi.js';

type Json = Record<string, unknown>;

const requestsOf = (items: readonly unknown[]): Json[] =>
  items.flatMap((item) => {
    const entry = item as Json;
    return entry['type'] === 'folder' ? requestsOf(entry['items'] as unknown[]) : [entry];
  });

describe('isOpenApi', () => {
  it('detects OpenAPI 3 and Swagger 2 documents only', () => {
    expect(isOpenApi({ openapi: '3.0.0' })).toBe(true);
    expect(isOpenApi({ swagger: '2.0' })).toBe(true);
    expect(isOpenApi({ openapi: 3 })).toBe(false);
    expect(isOpenApi(null)).toBe(false);
    expect(isOpenApi([])).toBe(false);
    expect(isOpenApi('openapi')).toBe(false);
  });
});

describe('sampleFor', () => {
  const doc: Json = {
    components: {
      schemas: {
        Pet: { type: 'object', properties: { name: { type: 'string' } } },
        Loop: { type: 'object', properties: { self: { $ref: '#/components/schemas/Loop' } } },
        'a/b~c': { type: 'integer' },
      },
    },
  };

  it('prefers the schema own values', () => {
    expect(sampleFor(doc, { example: 5, type: 'string' })).toBe(5);
    expect(sampleFor(doc, { examples: ['x', 'y'] })).toBe('x');
    expect(sampleFor(doc, { default: 'd', type: 'string' })).toBe('d');
    expect(sampleFor(doc, { enum: ['one', 'two'] })).toBe('one');
  });

  it('ignores empty example and enum lists', () => {
    expect(sampleFor(doc, { examples: [], enum: [], type: 'boolean' })).toBe(true);
  });

  it('resolves references, escaped pointers and unknown or remote references', () => {
    expect(sampleFor(doc, { $ref: '#/components/schemas/Pet' })).toEqual({ name: 'string' });
    expect(sampleFor(doc, { $ref: '#/components/schemas/a~1b~0c' })).toBe(0);
    expect(sampleFor(doc, { $ref: 'http://other/schema' })).toBeNull();
    expect(sampleFor(doc, { $ref: '#/components/missing/Deep' })).toBeNull();
    expect(sampleFor(doc, { $ref: '#/components/schemas/Loop' })).toEqual({
      self: null,
    });
  });

  it('stops on circular schemas and excessive depth', () => {
    const circular: Json = { type: 'object', properties: {} };
    (circular['properties'] as Json)['self'] = circular;
    expect(sampleFor({}, circular)).toEqual({ self: null });
    const deep: Json = { type: 'array', items: null };
    let current = deep;
    for (let level = 0; level < 12; level += 1) {
      const next: Json = { type: 'array', items: null };
      current['items'] = next;
      current = next;
    }
    expect(JSON.stringify(sampleFor({}, deep))).toContain('null');
    const refLoop: Json = { $ref: '#/a' };
    expect(sampleFor({ a: refLoop }, refLoop)).toBeNull();
  });

  it('combines allOf, picks the first of oneOf and anyOf, and ignores empty lists', () => {
    expect(
      sampleFor(doc, {
        allOf: [
          { type: 'object', properties: { a: { type: 'integer' } } },
          { type: 'string' },
          { type: 'object', properties: { b: { type: 'boolean' } } },
        ],
      }),
    ).toEqual({ a: 0, b: true });
    expect(sampleFor(doc, { oneOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(0);
    expect(sampleFor(doc, { anyOf: [{ type: 'boolean' }] })).toBe(true);
    expect(sampleFor(doc, { oneOf: [], type: 'string' })).toBe('string');
    expect(sampleFor(doc, { allOf: 'nope', type: 'number' })).toBe(0);
  });

  it('builds samples by type and format', () => {
    expect(sampleFor(doc, { type: ['integer', 'null'] })).toBe(0);
    expect(sampleFor(doc, { type: 'object' })).toEqual({});
    expect(sampleFor(doc, { properties: { x: { type: 'string' } } })).toEqual({ x: 'string' });
    expect(sampleFor(doc, { type: 'array', items: { type: 'string' } })).toEqual(['string']);
    expect(sampleFor(doc, { type: 'string', format: 'date-time' })).toBe('2026-01-01T00:00:00Z');
    expect(sampleFor(doc, { type: 'string', format: 'date' })).toBe('2026-01-01');
    expect(sampleFor(doc, { type: 'string', format: 'email' })).toBe('user@example.com');
    expect(sampleFor(doc, { type: 'string', format: 'uuid' })).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
    expect(sampleFor(doc, { type: 'string' })).toBe('string');
    expect(sampleFor(doc, { type: 'weird' })).toBeNull();
    expect(sampleFor(doc, {})).toBeNull();
    expect(sampleFor(doc, 'not a schema')).toBeNull();
    expect(sampleFor(doc, { type: 7 })).toBeNull();
    expect(sampleFor(doc, { type: [] })).toBeNull();
  });
});

describe('importOpenApi', () => {
  it('imports an empty document with defaults', () => {
    const result = importOpenApi({});
    expect(result).toMatchObject({
      name: 'OpenAPI',
      auth: { type: 'none' },
      items: [],
      variables: [{ key: 'baseUrl', value: 'http://localhost' }],
    });
    expect(result.description).toBeUndefined();
  });

  it('groups operations by tag and builds requests with parameters and bodies', () => {
    const document: Json = {
      openapi: '3.0.0',
      info: { title: 'Pets', description: 'The pets API' },
      servers: [
        {
          url: 'https://{host}/{version}/',
          variables: { host: { default: 'api.test' }, version: { default: 'v1' }, gone: null },
        },
      ],
      paths: {
        '/pets/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { $ref: '#/components/parameters/Trace' },
          ],
          get: {
            tags: ['pets'],
            summary: 'Get a pet',
            description: 'Fetches one pet',
            parameters: [
              { name: 'q', in: 'query', required: true, example: 'cat' },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
              { name: 'flags', in: 'query', example: ['a'] },
              {
                name: 'blank',
                in: 'query',
                schema: { type: 'null' },
              },
              { name: 'X-Mode', in: 'header', type: 'string' },
              { name: 'id', in: 'path', schema: { type: 'string' } },
              'ignored',
            ],
            responses: { '404': {}, '200': {} },
          },
          put: {
            tags: ['pets'],
            operationId: 'putPet',
            security: [],
            requestBody: {
              content: {
                'application/json': { example: { a: 1 } },
              },
            },
            responses: { default: {} },
          },
          post: {
            tags: [],
            requestBody: {
              content: {
                'application/json': {
                  examples: { first: { value: { name: 'rex' } } },
                },
              },
            },
            responses: { '201': {} },
          },
          patch: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                'application/vnd.api+json': {
                  examples: { first: { $ref: '#/components/examples/E' } },
                },
              },
            },
          },
          delete: {
            tags: ['other'],
            requestBody: { content: { 'application/json': { schema: { type: 'string' } } } },
            responses: { '204': {} },
          },
          head: {
            requestBody: { content: { 'application/json': 'not an object' } },
          },
          options: {
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: { properties: { user: { type: 'string' }, pass: { type: 'string' } } },
                },
              },
            },
          },
        },
        '/form': {
          post: {
            requestBody: {
              content: { 'application/x-www-form-urlencoded': {} },
            },
          },
        },
        '/ref': { $ref: '#/components/pathItems/Shared' },
        '/skip': 'not an object',
      },
      components: {
        parameters: { Trace: { name: 'X-Trace', in: 'header', schema: { type: 'string' } } },
        examples: { E: { value: { id: 7 } } },
        pathItems: { Shared: { get: { summary: 'Shared op' } } },
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearerAuth: [] }, 'nope'],
    };
    const result = importOpenApi(document);
    expect(result.name).toBe('Pets');
    expect(result.description).toBe('The pets API');
    expect(result.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(result.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.test/v1' },
      { key: 'id', value: '0' },
      { key: 'token', value: '', secret: true },
    ]);
    const folders = result.items.filter((item) => item.type === 'folder').map((item) => item.name);
    expect(folders).toEqual(['pets', 'other']);
    const requests = requestsOf(result.items);
    const byName = (name: string) => requests.find((request) => request['name'] === name)!;
    const get = byName('Get a pet');
    expect(get).toMatchObject({
      description: 'Fetches one pet',
      method: 'GET',
      url: '{{baseUrl}}/pets/{{id}}',
      assertions: [expect.objectContaining({ source: 'status', expected: '200' })],
    });
    expect(get['query']).toEqual([
      { key: 'q', value: 'cat' },
      { key: 'limit', value: '0', enabled: false },
      { key: 'flags', value: '["a"]', enabled: false },
      { key: 'blank', value: '', enabled: false },
    ]);
    expect(get['headers']).toEqual([
      { key: 'X-Trace', value: 'string' },
      { key: 'X-Mode', value: 'string' },
    ]);
    const put = byName('putPet');
    expect(put).toMatchObject({
      auth: { type: 'none' },
      assertions: [],
      body: { mode: 'json', content: JSON.stringify({ a: 1 }, null, 2) },
    });
    expect(put['description']).toBeUndefined();
    expect(byName('POST /pets/{id}')['body']).toEqual({
      mode: 'json',
      content: JSON.stringify({ name: 'rex' }, null, 2),
    });
    const patch = byName('PATCH /pets/{id}');
    expect(patch['auth']).toEqual({ type: 'inherit' });
    expect(patch['body']).toEqual({ mode: 'json', content: JSON.stringify({ id: 7 }, null, 2) });
    expect(byName('DELETE /pets/{id}')['body']).toEqual({ mode: 'json', content: '"string"' });
    expect(byName('HEAD /pets/{id}')['body']).toEqual({ mode: 'none' });
    expect(byName('OPTIONS /pets/{id}')['body']).toEqual({
      mode: 'urlencoded',
      fields: [
        { key: 'user', value: '' },
        { key: 'pass', value: '' },
      ],
    });
    expect(requests.find((request) => request['url'] === '{{baseUrl}}/form')!['body']).toEqual({
      mode: 'urlencoded',
      fields: [],
    });
    expect(byName('Shared op')['url']).toBe('{{baseUrl}}/ref');
  });

  it('reads Swagger 2 documents with body parameters and basic auth', () => {
    const result = importOpenApi({
      swagger: '2.0',
      host: 'api.test',
      basePath: '/v2/',
      schemes: ['http'],
      securityDefinitions: { basic: { type: 'basic' } },
      paths: {
        '/items': {
          post: {
            parameters: [
              {
                name: 'body',
                in: 'body',
                schema: { type: 'object', properties: { n: { type: 'integer' } } },
              },
            ],
            responses: { '200': {} },
          },
        },
      },
    });
    expect(result.auth).toEqual({
      type: 'basic',
      username: '{{username}}',
      password: '{{password}}',
    });
    expect(result.variables).toEqual([
      { key: 'baseUrl', value: 'http://api.test/v2' },
      { key: 'username', value: '', secret: true },
      { key: 'password', value: '', secret: true },
    ]);
    expect(requestsOf(result.items)[0]!['body']).toEqual({
      mode: 'json',
      content: JSON.stringify({ n: 0 }, null, 2),
    });
    const noSchemes = importOpenApi({ swagger: '2.0', host: 'h.test' });
    expect(noSchemes.variables[0]).toEqual({ key: 'baseUrl', value: 'https://h.test' });
    const odd = importOpenApi({ swagger: '2.0', host: 'h.test', schemes: [], basePath: [] });
    expect(odd.variables[0]!.value).toBe('://h.test');
    const serverless = importOpenApi({ servers: ['x'], host: 'h.test' });
    expect(serverless.variables[0]!.value).toBe('https://h.test');
  });

  it('maps security schemes to collection auth', () => {
    const auth = (schemes: unknown, extra: Json = {}) =>
      importOpenApi({ components: { securitySchemes: schemes }, ...extra }).auth;
    expect(auth({ a: { type: 'oauth2' } })).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(auth({ a: { type: 'openIdConnect' } })).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(auth({ a: { type: 'http', scheme: 'Basic' } })).toMatchObject({ type: 'basic' });
    expect(auth({ a: { type: 'apiKey', name: 'X-Key', in: 'query' } })).toEqual({
      type: 'apikey',
      key: 'X-Key',
      value: '{{apiKey}}',
      in: 'query',
    });
    expect(auth({ a: { type: 'apiKey' } })).toEqual({
      type: 'apikey',
      key: 'X-API-Key',
      value: '{{apiKey}}',
      in: 'header',
    });
    expect(auth({ a: { type: 'http', scheme: 'digest' } })).toEqual({ type: 'none' });
    expect(auth({ a: 'oops' })).toEqual({ type: 'none' });
    expect(auth({})).toEqual({ type: 'none' });
    expect(auth('bad')).toEqual({ type: 'none' });
    expect(
      auth(
        { a: { type: 'http', scheme: 'bearer' }, b: { type: 'basic' } },
        { security: [{ b: [] }] },
      ),
    ).toMatchObject({ type: 'basic' });
    expect(
      auth({ a: { type: 'oauth2' }, b: { type: 'basic' } }, { security: [{ missing: [] }] }),
    ).toEqual({ type: 'bearer', token: '{{token}}' });
    const apikey = importOpenApi({ components: { securitySchemes: { a: { type: 'apiKey' } } } });
    expect(apikey.variables.map((variable) => variable.key)).toEqual(['baseUrl', 'apiKey']);
  });
});

describe('importOpenApi defaults', () => {
  it('handles servers without variables and parameters without a type', () => {
    const result = importOpenApi({
      servers: [{ url: 'https://api.test/' }],
      paths: { '/x': { get: { parameters: [{ name: 'X-Plain', in: 'header' }] } } },
    });
    expect(result.variables[0]).toEqual({ key: 'baseUrl', value: 'https://api.test' });
    expect(requestsOf(result.items)[0]!['headers']).toEqual([{ key: 'X-Plain', value: 'string' }]);
  });
});
