import { describe, expect, it } from 'vitest';
import type { ApiFolder, ApiRequestSpec } from '../src/modules/apitests/engine/types.js';
import { importOpenApi, isOpenApi } from '../src/modules/apitests/formats/openapi.js';

const requests = (items: readonly unknown[]): ApiRequestSpec[] =>
  items.flatMap((item) =>
    (item as ApiFolder).type === 'folder'
      ? requests((item as ApiFolder).items)
      : [item as ApiRequestSpec],
  );
const byName = (items: readonly unknown[], name: string) =>
  requests(items).find((request) => request.name === name)!;

describe('isOpenApi', () => {
  it('accepts openapi and swagger documents only', () => {
    expect(isOpenApi({ openapi: '3.0.0' })).toBe(true);
    expect(isOpenApi({ swagger: '2.0' })).toBe(true);
    expect(isOpenApi({ openapi: 3 })).toBe(false);
    expect(isOpenApi('openapi')).toBe(false);
  });
});

describe('importOpenApi edge cases', () => {
  it('samples schemas, refs, parameters and bodies of an OpenAPI 3 document', () => {
    const imported = importOpenApi({
      openapi: '3.0.0',
      info: { title: 'Shop', description: 'Shop API', version: 1 },
      servers: [
        {
          url: 'https://{env}.{region}.test/v{ver}/',
          variables: { env: { default: 'api' }, region: 'bad', ver: { default: 2 } },
        },
      ],
      security: [{ missing: [] }, 'bad'],
      components: {
        securitySchemes: { key: { $ref: '#/components/schemes/key' } },
        schemes: { key: { type: 'apiKey', in: 'query' } },
        schemas: {
          Loop: { $ref: '#/components/schemas/Loop' },
          'a/b~c': { type: 'string', format: 'uuid' },
          Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
        },
      },
      paths: {
        '/broken': { $ref: 'other.yaml#/paths/x' },
        '/items/{id}': {
          parameters: [
            { $ref: '#/components/schemas/Missing' },
            { name: 'id', in: 'path', schema: { type: 'integer' } },
            'skip',
          ],
          get: {
            tags: ['Items'],
            operationId: 'getItem',
            parameters: [
              { name: 'id', in: 'path', example: 'second' },
              { name: 'q', in: 'query', required: true, schema: { type: ['string', 'null'] } },
              { name: 'n', in: 'query', type: 'number' },
              { name: 'flag', in: 'query', schema: { type: 'boolean' } },
              {
                name: 'list',
                in: 'query',
                schema: { type: 'array', items: { type: 'string', format: 'email' } },
              },
              { name: 'when', in: 'query', schema: { type: 'string', format: 'date-time' } },
              { name: 'day', in: 'query', schema: { type: 'string', format: 'date' } },
              { name: 'uid', in: 'query', schema: { $ref: '#/components/schemas/a~1b~0c' } },
              { name: 'loop', in: 'query', schema: { $ref: '#/components/schemas/Loop' } },
              { name: 'ext', in: 'query', schema: { $ref: 'ext.json#/X' } },
              { name: 'none', in: 'query', schema: {} },
              { name: 'ex', in: 'query', schema: { examples: ['e1'] } },
              { name: 'def', in: 'query', schema: { default: 5 } },
              { name: 'en', in: 'query', schema: { enum: ['A', 'B'] } },
              { name: 'one', in: 'query', schema: { oneOf: [{ type: 'integer' }] } },
              { name: 'node', in: 'query', schema: { $ref: '#/components/schemas/Node' } },
              { name: 'deep', in: 'query', schema: { $ref: '#/info/title/deep' } },
              { name: 'obj', in: 'query', schema: { type: 'object' } },
              { name: 'plain', in: 'query' },
              { name: 'X-Trace', in: 'header', schema: { example: 't' } },
            ],
            responses: { default: {}, '201': {} },
            security: [],
          },
          post: {
            tags: [],
            summary: 'Create item',
            description: 'Creates it',
            requestBody: {
              content: {
                'application/json': {
                  examples: { first: { value: { name: 'from example' } } },
                },
              },
            },
          },
          put: {
            summary: 'Replace item',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { properties: { a: { type: 'string' } } },
                      { type: 'string', example: 'not-an-object' },
                    ],
                  },
                },
              },
            },
          },
          patch: {
            summary: 'Patch item',
            requestBody: { content: { 'application/json': { example: { op: 'x' } } } },
          },
          delete: {
            summary: 'Delete item',
            requestBody: { content: { 'application/json': 'bad' } },
          },
          head: {
            summary: 'Head item',
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': { schema: { properties: { u: {}, v: {} } } },
              },
            },
          },
          options: {
            summary: 'Options item',
            requestBody: { content: { 'application/x-www-form-urlencoded': {} } },
          },
        },
        '/examples': {
          get: {
            summary: 'Named raw',
            requestBody: { content: { 'application/json': { examples: { a: 'plain' } } } },
          },
          post: {
            summary: 'Named no value',
            requestBody: { content: { 'application/json': { examples: { a: { summary: 's' } } } } },
          },
        },
      },
    });
    expect(imported.name).toBe('Shop');
    expect(imported.description).toBe('Shop API');
    expect(imported.auth).toEqual({
      type: 'apikey',
      key: 'X-API-Key',
      value: '{{apiKey}}',
      in: 'query',
    });
    expect(imported.variables).toEqual([
      { key: 'baseUrl', value: 'https://api..test/v2' },
      { key: 'id', value: '0' },
      { key: 'apiKey', value: '', secret: true },
    ]);
    const get = byName(imported.items, 'getItem');
    expect(get.auth).toEqual({ type: 'none' });
    expect(get.assertions[0]).toMatchObject({ source: 'status', expected: '201' });
    expect(get.headers).toEqual([{ key: 'X-Trace', value: 't' }]);
    expect(Object.fromEntries(get.query.map((entry) => [entry.key, entry]))).toMatchObject({
      q: { value: 'string' },
      n: { value: '0', enabled: false },
      flag: { value: 'true' },
      list: { value: '["user@example.com"]' },
      when: { value: '2026-01-01T00:00:00Z' },
      day: { value: '2026-01-01' },
      uid: { value: '00000000-0000-4000-8000-000000000000' },
      loop: { value: '' },
      ext: { value: '' },
      none: { value: '' },
      ex: { value: 'e1' },
      def: { value: '5' },
      en: { value: 'A' },
      one: { value: '0' },
      node: { value: '{"child":null}' },
      deep: { value: '' },
      obj: { value: '{}' },
      plain: { value: 'string' },
    });
    expect(get.query.find((entry) => entry.key === 'q')).not.toHaveProperty('enabled');
    const post = byName(imported.items, 'Create item');
    expect(post.description).toBe('Creates it');
    expect(post.auth).toEqual({ type: 'inherit' });
    expect(post.assertions).toEqual([]);
    expect(JSON.parse((post.body as { content: string }).content)).toEqual({
      name: 'from example',
    });
    expect(
      JSON.parse((byName(imported.items, 'Replace item').body as { content: string }).content),
    ).toEqual({ a: 'string' });
    expect(
      JSON.parse((byName(imported.items, 'Patch item').body as { content: string }).content),
    ).toEqual({ op: 'x' });
    expect(byName(imported.items, 'Delete item').body).toEqual({ mode: 'none' });
    expect(byName(imported.items, 'Head item').body).toEqual({
      mode: 'urlencoded',
      fields: [
        { key: 'u', value: '' },
        { key: 'v', value: '' },
      ],
    });
    expect(byName(imported.items, 'Options item').body).toEqual({ mode: 'urlencoded', fields: [] });
    expect((byName(imported.items, 'Named raw').body as { content: string }).content).toBe('null');
    expect(
      JSON.parse((byName(imported.items, 'Named no value').body as { content: string }).content),
    ).toEqual({ summary: 's' });
    expect(imported.items[0]).toMatchObject({ type: 'folder', name: 'Items' });
  });

  it('reads Swagger 2 hosts, body parameters and every security scheme type', () => {
    const swagger = (extra: Record<string, unknown>) =>
      importOpenApi({
        swagger: '2.0',
        paths: {
          '/a': {
            post: {
              tags: ['T', 'U'],
              parameters: [
                {
                  name: 'body',
                  in: 'body',
                  schema: { type: 'object', properties: { n: { type: 'number' } } },
                },
              ],
            },
            get: { tags: ['T'] },
          },
          '/b': 'not-an-object',
        },
        ...extra,
      });
    const basic = swagger({
      host: 'api.test',
      basePath: '/v1/',
      schemes: ['http'],
      securityDefinitions: { b: { type: 'basic' } },
    });
    expect(basic.name).toBe('OpenAPI');
    expect(basic).not.toHaveProperty('description');
    expect(basic.variables).toEqual([
      { key: 'baseUrl', value: 'http://api.test/v1' },
      { key: 'username', value: '', secret: true },
      { key: 'password', value: '', secret: true },
    ]);
    expect(basic.auth).toEqual({
      type: 'basic',
      username: '{{username}}',
      password: '{{password}}',
    });
    const [folder] = basic.items as ApiFolder[];
    expect(folder!.items).toHaveLength(2);
    expect((folder!.items[0] as ApiRequestSpec).name).toBe('GET /a');
    expect(
      JSON.parse(((folder!.items[1] as ApiRequestSpec).body as { content: string }).content),
    ).toEqual({ n: 0 });

    const bearer = swagger({
      host: 'h',
      securityDefinitions: { o: { type: 'oauth2' } },
      security: [{ o: [] }],
    });
    expect(bearer.variables[0]).toEqual({ key: 'baseUrl', value: 'https://h' });
    expect(bearer.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(bearer.variables[1]).toEqual({ key: 'token', value: '', secret: true });
    expect(swagger({ securityDefinitions: { o: { type: 'openIdConnect' } } }).auth.type).toBe(
      'bearer',
    );
    expect(
      swagger({ components: { securitySchemes: { h: { type: 'http', scheme: 'Bearer' } } } }).auth
        .type,
    ).toBe('bearer');
    expect(
      swagger({ components: { securitySchemes: { h: { type: 'http', scheme: 'basic' } } } }).auth
        .type,
    ).toBe('basic');
    expect(
      swagger({ components: { securitySchemes: { h: { type: 'http', scheme: 'digest' } } } }).auth,
    ).toEqual({ type: 'none' });
    expect(
      swagger({
        components: { securitySchemes: { k: { type: 'apiKey', name: 'X-K', in: 'header' } } },
      }).auth,
    ).toEqual({ type: 'apikey', key: 'X-K', value: '{{apiKey}}', in: 'header' });
    expect(swagger({ securityDefinitions: { s: 'bad' } }).auth).toEqual({ type: 'none' });
    const none = swagger({ servers: ['bad'] });
    expect(none.auth).toEqual({ type: 'none' });
    expect(none.variables).toEqual([{ key: 'baseUrl', value: 'http://localhost' }]);
    expect(swagger({ servers: [{ url: 'https://x.test' }] }).variables[0]!.value).toBe(
      'https://x.test',
    );
  });

  it('handles documents without paths or info', () => {
    const imported = importOpenApi({ openapi: '3.1.0', info: 'x', paths: [] });
    expect(imported.items).toEqual([]);
    expect(imported.name).toBe('OpenAPI');
  });
});
