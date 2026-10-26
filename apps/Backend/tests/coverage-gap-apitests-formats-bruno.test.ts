import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import type { ApiRequestSpec, Assertion } from '../src/modules/apitests/engine/types.js';
import { exportBruno } from '../src/modules/apitests/formats/bruno.js';

const request = (overrides: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id: 'r',
  type: 'request',
  name: 'Req',
  method: 'GET',
  url: '{{baseUrl}}/x',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

const fileOf = (files: { path: string; content: string }[], path: string) =>
  files.find((file) => file.path === path)?.content ?? '';

describe('exportBruno edge cases', () => {
  it('falls back to "untitled", maps basic collection auth and keeps blank doc lines', () => {
    const files = exportBruno({
      name: '***',
      description: 'line one\n\nline three',
      variables: [{ key: 'pass', value: 'hidden', secret: true }],
      auth: { type: 'basic', username: 'u', password: 'p' },
      items: [],
    });
    expect(files[0]!.path).toBe('-/bruno.json');
    expect(fileOf(files, '-/collection.bru')).toContain('mode: basic');
    expect(fileOf(files, '-/collection.bru')).toContain('username: u');
    expect(fileOf(files, '-/collection.bru')).toContain('pass: \n');
    expect(fileOf(files, '-/collection.bru')).toContain('docs {\n  line one\n\n  line three\n}');
    const empty = exportBruno({ name: '  ', variables: [], auth: { type: 'inherit' }, items: [] });
    expect(empty[0]!.path).toBe('untitled/bruno.json');
    expect(fileOf(empty, 'untitled/collection.bru')).toContain('mode: none');
  });

  it('writes environments with secret and disabled variables', () => {
    const files = exportBruno({ name: 'Env', variables: [], auth: { type: 'none' }, items: [] }, [
      {
        name: 'dev',
        variables: [
          { key: 'host', value: 'h' },
          { key: 'off', value: 'x', enabled: false },
          { key: 'token', value: 'secret', secret: true },
        ],
      },
      { name: 'only-secret', variables: [{ key: 'k', value: 'v', secret: true }] },
      { name: 'plain', variables: [{ key: 'p', value: '1' }] },
    ]);
    expect(fileOf(files, 'Env/environments/dev.bru')).toBe(
      'vars {\n  host: h\n}\n\nvars:secret [\n  token\n]\n',
    );
    expect(fileOf(files, 'Env/environments/only-secret.bru')).toBe('vars:secret [\n  k\n]\n');
    expect(fileOf(files, 'Env/environments/plain.bru')).toBe('vars {\n  p: 1\n}\n');
  });

  it('maps every body mode, auth type, capture source and assertion operator', () => {
    const assertions: Assertion[] = [
      { id: '1', source: 'duration', operator: 'lt', expected: '500' },
      { id: '2', source: 'header', path: 'Content-Type', operator: 'contains', expected: 'json' },
      { id: '3', source: 'header', operator: 'exists' },
      { id: '4', source: 'body', operator: 'notContains', expected: 'error' },
      { id: '5', source: 'json', path: '$', operator: 'neq', expected: 'true' },
      { id: '6', source: 'json', operator: 'notExists' },
      { id: '7', source: 'json', path: 'n', operator: 'lte', expected: '3.5' },
      { id: '8', source: 'json', path: 'n', operator: 'gt', expected: '-1' },
      { id: '9', source: 'json', path: 'n', operator: 'gte', expected: '0' },
      { id: '10', source: 'json', path: 's', operator: 'matches', expected: '^a' },
      { id: '11', source: 'json', path: 's', operator: 'isType', expected: 'STRING' },
      { id: '12', source: 'json', path: 's', operator: 'eq', expected: 'null' },
    ];
    const collection: CollectionInput = {
      name: 'All',
      variables: [],
      auth: { type: 'apikey', key: 'K', value: 'V', in: 'header' },
      items: [
        request({
          name: 'Same',
          method: 'POST',
          body: { mode: 'urlencoded', fields: [{ key: 'a', value: '1', enabled: false }] },
          auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' },
          pathParams: [{ key: 'id', value: '1' }],
          assertions,
          captures: [
            { variable: 's', source: 'status' },
            { variable: 'h', source: 'header', path: 'X-Id' },
            { variable: 'b', source: 'body' },
            { variable: 'j', source: 'json', path: '$.data.id' },
          ],
          description: 'doc',
        }),
        request({
          name: 'same',
          body: { mode: 'form', fields: [{ key: 'f', value: 'v' }] },
          auth: { type: 'none' },
        }),
        request({ name: 'Same', body: { mode: 'xml', content: '<a/>' } }),
        {
          id: 'f',
          type: 'folder',
          name: 'Plain',
          items: [request({ name: 'Inner', body: { mode: 'text', content: 'hi' } })],
        },
      ],
    };
    const files = exportBruno(collection);
    const first = fileOf(files, 'All/Same.bru');
    expect(first).toContain('body: formUrlEncoded');
    expect(first).toContain('auth: apikey');
    expect(first).toContain('placement: queryparams');
    expect(first).toContain('body:form-urlencoded {\n  ~a: 1\n}');
    expect(first).toContain('params:path {\n  id: 1\n}');
    for (const line of [
      'res.responseTime: lt 500',
      'res.headers["content-type"]: contains "json"',
      'res.headers[""]: isDefined',
      'res.body: notContains "error"',
      'res.body: neq true',
      'res.body: isUndefined',
      'res.body.n: lte 3.5',
      'res.body.n: gt -1',
      'res.body.n: gte 0',
      'res.body.s: matches ^a',
      'res.body.s: isString',
      'res.body.s: eq null',
      's: res.status',
      'h: res.headers["x-id"]',
      'b: res.body',
      'j: res.body.data.id',
      'docs {\n  doc\n}',
    ]) {
      expect(first).toContain(line);
    }
    const second = fileOf(files, 'All/same 2.bru');
    expect(second).toContain('body: multipartForm');
    expect(second).toContain('auth: none');
    expect(second).toContain('body:multipart-form {\n  f: v\n}');
    expect(fileOf(files, 'All/Same 3.bru')).toContain('body:xml {\n  <a/>\n}');
    expect(fileOf(files, 'All/Plain/folder.bru')).toBe('meta {\n  name: Plain\n  seq: 4\n}\n');
    expect(fileOf(files, 'All/Plain/Inner.bru')).toContain('body:text {\n  hi\n}');
    expect(fileOf(files, 'All/collection.bru')).toContain('placement: header');
  });
});
