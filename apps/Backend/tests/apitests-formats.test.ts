import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import { flattenRequests } from '../src/modules/apitests/engine/collection-runner.js';
import { exportBruno } from '../src/modules/apitests/formats/bruno.js';
import {
  detectFormat,
  exportAdk,
  exportInsomnia,
  exportPostman,
  importCollection,
} from '../src/modules/apitests/formats/index.js';
import { exportK6 } from '../src/modules/apitests/formats/k6.js';
import {
  assertionsFromScript,
  capturesFromScript,
} from '../src/modules/apitests/formats/postman.js';
import { crc32, zip } from '../src/modules/apitests/formats/zip.js';

const collection: CollectionInput = {
  name: 'Store API',
  description: 'Orders and auth',
  variables: [
    { key: 'baseUrl', value: 'https://api.store.test' },
    { key: 'password', value: 'hunter2-pass', secret: true },
  ],
  auth: { type: 'none' },
  items: [
    {
      id: 'login',
      type: 'request',
      name: 'Login',
      method: 'POST',
      url: '{{baseUrl}}/login',
      headers: [{ key: 'X-Trace', value: 'on', enabled: false }],
      query: [],
      body: { mode: 'json', content: '{"password":"{{password}}"}' },
      auth: { type: 'inherit' },
      assertions: [
        { id: 'a1', source: 'status', operator: 'eq', expected: '200' },
        { id: 'a2', source: 'json', path: 'user.id', operator: 'exists' },
      ],
      captures: [{ variable: 'token', source: 'json', path: 'data.token' }],
    },
    {
      id: 'orders',
      type: 'folder',
      name: 'Orders',
      auth: { type: 'bearer', token: '{{token}}' },
      items: [
        {
          id: 'list',
          type: 'request',
          name: 'List orders',
          method: 'GET',
          url: '{{baseUrl}}/orders',
          headers: [],
          query: [{ key: 'page', value: '1' }],
          body: { mode: 'none' },
          auth: { type: 'inherit' },
          assertions: [{ id: 'b1', source: 'duration', operator: 'lt', expected: '800' }],
          captures: [],
        },
      ],
    },
  ],
};

const shape = (input: CollectionInput) =>
  flattenRequests(input).map(({ request, path, auth }) => ({
    name: request.name,
    method: request.method,
    url: request.url,
    path,
    auth: auth.type,
    query: request.query.map((entry) => `${entry.key}=${entry.value}`),
    assertions: request.assertions.map(({ source, path: at, operator, expected }) => ({
      source,
      at,
      operator,
      expected,
    })),
    captures: request.captures,
  }));

describe('ADK and Postman', () => {
  it('round-trips a collection through Postman v2.1 with checks and captures as scripts', () => {
    const postman = exportPostman(collection);
    expect(detectFormat(postman)).toBe('postman');
    const script = JSON.stringify(postman);
    expect(script).toContain(
      'pm.collectionVariables.set(\\"token\\", pm.response.json().data.token)',
    );
    // Secret values never leave ADK.
    expect(script).not.toContain('hunter2-pass');
    const back = importCollection(JSON.stringify(postman));
    expect(back.format).toBe('postman');
    const original = shape(collection);
    const imported = shape(back.collection);
    // Status and capture scripts are recognised; other checks stay as Postman scripts only.
    expect(imported[0]).toMatchObject({
      ...original[0],
      assertions: [original[0]!.assertions[0]],
      captures: [{ variable: 'token', source: 'json', path: 'data.token' }],
    });
    expect(imported[1]).toMatchObject({
      name: 'List orders',
      path: ['Orders'],
      auth: 'bearer',
      query: ['page=1'],
    });
  });

  it('keeps path params through Postman, Bruno and k6', () => {
    const withPath = {
      ...collection,
      items: [
        {
          id: 'get-order',
          type: 'request' as const,
          name: 'Get order',
          method: 'GET' as const,
          url: '{{baseUrl}}/orders/:id',
          pathParams: [{ key: 'id', value: '{{orderId}}' }],
          headers: [],
          query: [],
          body: { mode: 'none' as const },
          auth: { type: 'inherit' as const },
          assertions: [],
          captures: [],
        },
      ],
    };
    const back = importCollection(JSON.stringify(exportPostman(withPath)));
    expect(back.collection.items[0]).toMatchObject({
      url: '{{baseUrl}}/orders/:id',
      pathParams: [{ key: 'id', value: '{{orderId}}' }],
    });
    const bru = exportBruno(withPath).find((file) => file.path.endsWith('Get order.bru'));
    expect(bru?.content).toContain('params:path {\n  id: {{orderId}}\n}');
    const k6 = exportK6(
      withPath,
      {
        name: 'Orders',
        requests: [{ requestId: 'get-order', weight: 1 }],
        stages: [{ durationSec: 10, targetVus: 1 }],
        thinkTimeMs: 0,
        thresholds: [],
      },
      [],
    );
    expect(k6).toContain('v("{{baseUrl}}/orders/{{orderId}}")');
  });

  it('recognises the usual Postman test snippets', () => {
    const script = [
      'pm.test("ok", () => pm.response.to.have.status(201));',
      'pm.expect(pm.response.responseTime).to.be.below(300);',
      'var jsonData = pm.response.json();',
      'pm.environment.set("orderId", jsonData.data.items[0].id);',
    ].join('\n');
    expect(
      assertionsFromScript(script).map((a) => `${a.source} ${a.operator} ${a.expected}`),
    ).toEqual(['status eq 201', 'duration lt 300']);
    expect(capturesFromScript(script)).toEqual([
      { variable: 'orderId', source: 'json', path: 'data.items[0].id' },
    ]);
  });

  it('keeps everything in the ADK format, except secret values', () => {
    const file = exportAdk(collection, [
      { name: 'Staging', variables: [{ key: 'token', value: 'abc12345', secret: true }] },
    ]);
    const back = importCollection(JSON.stringify(file));
    expect(back.format).toBe('adk');
    expect(shape(back.collection)).toEqual(shape(collection));
    expect(back.environments).toEqual([
      { name: 'Staging', variables: [{ key: 'token', value: '', secret: true }] },
    ]);
  });
});

describe('Insomnia', () => {
  it('converts variable syntax both ways and keeps folders, auth and query', () => {
    const exported = exportInsomnia(collection);
    const text = JSON.stringify(exported);
    expect(text).toContain('{{ _.baseUrl }}/login');
    expect(detectFormat(exported)).toBe('insomnia');
    const back = importCollection(text);
    const imported = shape(back.collection);
    expect(
      imported.map(({ name, url, path, auth, query }) => ({ name, url, path, auth, query })),
    ).toEqual(
      shape(collection).map(({ name, url, path, auth, query }) => ({
        name,
        url,
        path,
        auth,
        query,
      })),
    );
    expect(back.collection.variables).toContainEqual({
      key: 'baseUrl',
      value: 'https://api.store.test',
    });
  });
});

describe('OpenAPI', () => {
  it('imports a YAML document with tags, examples, path variables and security', () => {
    const yaml = `
openapi: 3.0.3
info: { title: Pets, version: '1' }
servers: [{ url: 'https://{env}.pets.test/v1', variables: { env: { default: api } } }]
security: [{ bearer: [] }]
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  schemas:
    Pet:
      type: object
      properties:
        name: { type: string, example: Rex }
        age: { type: integer }
        tags: { type: array, items: { type: string } }
paths:
  /pets/{petId}:
    get:
      tags: [pets]
      summary: Get a pet
      parameters:
        - { name: petId, in: path, required: true, schema: { type: string, example: p-1 } }
        - { name: expand, in: query, schema: { type: boolean } }
      responses: { '200': { description: ok } }
  /pets:
    post:
      tags: [pets]
      operationId: createPet
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
      responses: { '201': { description: created } }
  /health:
    get:
      security: []
      responses: { '204': { description: ok } }
`;
    const { format, collection: imported } = importCollection(yaml);
    expect(format).toBe('openapi');
    expect(imported.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(imported.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.pets.test/v1' },
      { key: 'petId', value: 'p-1' },
      { key: 'token', value: '', secret: true },
    ]);
    const [get, create, health] = flattenRequests(imported);
    expect(get!.request).toMatchObject({
      name: 'Get a pet',
      url: '{{baseUrl}}/pets/{{petId}}',
      query: [{ key: 'expand', value: 'true', enabled: false }],
    });
    expect(get!.path).toEqual(['pets']);
    expect(get!.request.assertions[0]).toMatchObject({
      source: 'status',
      operator: 'eq',
      expected: '200',
    });
    expect(JSON.parse((create!.request.body as { content: string }).content)).toEqual({
      name: 'Rex',
      age: 0,
      tags: ['string'],
    });
    expect(health!.auth).toEqual({ type: 'none' });
  });

  it('refuses files it does not understand', () => {
    expect(() => importCollection('{"hello":"world"}')).toThrow(/Unrecognised file/);
    expect(() => importCollection('   ')).toThrow(/empty/);
    expect(() =>
      importCollection('{"format":"adk-api-collection","collection":{"name":""}}'),
    ).toThrow(/valid collection/);
  });
});

describe('Bruno', () => {
  it('writes .bru files with auth, query, body, asserts and captures, and a valid zip', () => {
    const files = exportBruno(collection, [
      {
        name: 'Staging',
        variables: [
          { key: 'baseUrl', value: 'https://staging.test' },
          { key: 'token', value: 'abc12345', secret: true },
        ],
      },
    ]);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
    expect(Object.keys(byPath).sort()).toEqual([
      'Store API/Login.bru',
      'Store API/Orders/List orders.bru',
      'Store API/Orders/folder.bru',
      'Store API/bruno.json',
      'Store API/collection.bru',
      'Store API/environments/Staging.bru',
    ]);
    const login = byPath['Store API/Login.bru']!;
    expect(login).toContain('post {\n  url: {{baseUrl}}/login\n  body: json\n  auth: inherit\n}');
    expect(login).toContain('headers {\n  ~X-Trace: on\n}');
    expect(login).toContain('assert {\n  res.status: eq 200\n  res.body.user.id: isDefined\n}');
    expect(login).toContain('vars:post-response {\n  token: res.body.data.token\n}');
    expect(byPath['Store API/Orders/folder.bru']).toContain('auth:bearer {\n  token: {{token}}\n}');
    expect(byPath['Store API/Orders/List orders.bru']).toContain('params:query {\n  page: 1\n}');
    expect(byPath['Store API/environments/Staging.bru']).toBe(
      'vars {\n  baseUrl: https://staging.test\n}\n\nvars:secret [\n  token\n]\n',
    );
    expect(byPath['Store API/collection.bru']).not.toContain('hunter2-pass');

    const archive = zip(files);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(files.length);
    const first = Buffer.from(files[0]!.content);
    expect(archive.readUInt32LE(14)).toBe(crc32(first));
  });
});

describe('k6', () => {
  it('exports stages, thresholds, weighted requests and checks as a valid script', () => {
    const script = exportK6(
      collection,
      {
        name: 'Orders peak',
        requests: [
          { requestId: 'login', weight: 1 },
          { requestId: 'list', weight: 4 },
        ],
        stages: [
          { durationSec: 30, targetVus: 20 },
          { durationSec: 60, targetVus: 20 },
        ],
        thinkTimeMs: 500,
        thresholds: [
          { metric: 'p95', operator: 'lt', value: 500 },
          { metric: 'errorRate', operator: 'lt', value: 0.01, abortOnFail: true },
          { metric: 'avg', operator: 'lt', value: 200 },
        ],
      },
      [{ key: 'token', value: 'abc12345', secret: true }],
    );
    expect(script).toContain('"duration": "30s"');
    expect(script).toContain('"p(95)<500"');
    expect(script).toContain('"avg<200"');
    expect(script).toContain('"abortOnFail": true');
    expect(script).toContain('weight: 4,');
    expect(script).toContain('"token": __ENV["token"] || \'\'');
    expect(script).toContain('"password": __ENV["password"] || \'\'');
    expect(script).not.toContain('hunter2-pass');
    expect(script).not.toContain('abc12345');
    expect(script).toContain("headers['Authorization'] = 'Bearer ' + v(\"{{token}}\")");
    expect(script).toContain('vars["token"] = String(json(r, "data.token") ?? \'\')');
    const file = join(mkdtempSync(join(tmpdir(), 'k6-')), 'script.mjs');
    writeFileSync(file, script);
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
  });
});
