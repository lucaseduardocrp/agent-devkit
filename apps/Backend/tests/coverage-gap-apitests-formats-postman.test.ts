import { describe, expect, it } from 'vitest';
import type { ApiFolder, ApiRequestSpec } from '../src/modules/apitests/engine/types.js';
import {
  assertionsFromScript,
  exportPostman,
  importPostman,
  isPostmanCollection,
} from '../src/modules/apitests/formats/postman.js';

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

const auth = (type: string, entries: Record<string, string>) => ({
  type,
  [type]: [...Object.entries(entries).map(([key, value]) => ({ key, value })), 'junk'],
});

describe('importPostman edge cases', () => {
  it('detects collections by their schema URL', () => {
    expect(
      isPostmanCollection({
        info: { schema: 'https://schema.postman.com/json/collection/v2.1.0/' },
      }),
    ).toBe(true);
    expect(isPostmanCollection({ info: 'x' })).toBe(false);
    expect(isPostmanCollection(null)).toBe(false);
  });

  it('recognises response time and header checks in test scripts', () => {
    const found = assertionsFromScript(
      'pm.expect(pm.response.code).to.eql(204);\npm.expect(pm.response.responseTime).to.be.below(300);\npm.response.to.have.header("X-Id");',
    );
    expect(found.map(({ id: _id, ...rest }) => rest)).toEqual([
      { source: 'status', operator: 'eq', expected: '204' },
      { source: 'duration', operator: 'lt', expected: '300' },
      { source: 'header', path: 'X-Id', operator: 'exists' },
    ]);
  });

  it('maps folders, auth types, bodies, URLs and scripts', () => {
    const raw = (body: Record<string, unknown>, header: unknown[] = []) => ({
      method: 'POST',
      header,
      url: 'http://x',
      body,
    });
    const imported = importPostman({
      info: { name: '', description: { content: 'Described' } },
      variable: [{ key: 'v', value: 1, disabled: true }],
      auth: { type: 'oauth1' },
      item: [
        {
          name: '',
          description: 'Folder doc',
          auth: auth('basic', { username: 'u', password: 'p' }),
          item: [
            {
              name: 'Raw json',
              request: {
                ...raw({ mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } }),
                auth: auth('apikey', { in: 'query', value: 'v' }),
                description: { content: 'Object doc' },
              },
              event: [
                { listen: 'prerequest', script: { exec: 'ignored' } },
                { listen: 'test', script: 'not-an-object' },
                { listen: 'test', script: { exec: 'pm.response.to.have.status(201)' } },
                {
                  listen: 'test',
                  script: { exec: ['pm.environment.set("t", pm.response.json().token)', 5] },
                },
              ],
            },
            {
              name: 'Ct json',
              request: {
                ...raw({ mode: 'raw', raw: 'a' }, [
                  { key: 'Content-Type', value: 'application/json' },
                ]),
                auth: auth('apikey', { key: 'K', value: 'v' }),
              },
            },
            {
              name: 'Raw xml',
              request: {
                ...raw({ mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } }),
                auth: auth('bearer', { token: 't' }),
              },
            },
            {
              name: 'Ct xml',
              request: {
                ...raw({ mode: 'raw', raw: '<a/>' }, [{ key: 'content-type', value: 'text/xml' }]),
                auth: { type: 'noauth' },
              },
            },
            { name: 'Raw text', request: raw({ mode: 'raw', raw: 'hi', options: 'bad' }) },
            {
              name: 'Encoded',
              request: raw({ mode: 'urlencoded', urlencoded: [{ key: 'a', value: 'b' }] }),
            },
            {
              name: 'Form',
              request: raw({
                mode: 'formdata',
                formdata: [{ key: 'f', value: 'v' }, { key: 'file', type: 'file' }, 'x'],
              }),
            },
            {
              name: 'Graphql',
              request: raw({ mode: 'graphql', graphql: { query: '{ a }', variables: '{"x":1}' } }),
            },
            { name: 'Graphql bare', request: raw({ mode: 'graphql', graphql: 'bad' }) },
            { name: 'Binary', request: raw({ mode: 'file' }) },
          ],
        },
        { name: 'String request', request: 'http://plain.test' },
        {
          name: 'Odd method',
          request: { method: 'brew', url: 42, body: 'x', description: 'Plain doc' },
        },
        {
          name: 'Query',
          request: {
            url: {
              raw: 'http://q.test/a/:id?x=1',
              query: [{ key: 'x', value: '1' }],
              variable: [{ key: 'id', value: '7' }],
            },
          },
        },
        { name: 'Raw only url', request: { url: { raw: 'http://r.test?y=2' } } },
        { name: 'No auth', item: [] },
      ],
    });
    expect(imported.name).toBe('Postman collection');
    expect(imported.description).toBe('Described');
    expect(imported.auth).toEqual({ type: 'none' });
    expect(imported.variables).toEqual([{ key: 'v', value: '1', enabled: false }]);
    const [folder, plain, odd, query, rawOnly, noAuth] = imported.items as [
      ApiFolder,
      ...ApiRequestSpec[],
    ];
    expect(folder).toMatchObject({
      name: 'Untitled',
      description: 'Folder doc',
      auth: { type: 'basic', username: 'u', password: 'p' },
    });
    const items = folder.items as ApiRequestSpec[];
    const named = (name: string) => items.find((item) => item.name === name)!;
    expect(named('Raw json')).toMatchObject({
      method: 'POST',
      description: 'Object doc',
      body: { mode: 'json', content: '{}' },
      auth: { type: 'apikey', key: 'X-API-Key', value: 'v', in: 'query' },
      assertions: [{ source: 'status', operator: 'eq', expected: '201' }],
      captures: [{ variable: 't', source: 'json', path: 'token' }],
    });
    expect(named('Ct json').body.mode).toBe('json');
    expect(named('Ct json').auth).toEqual({ type: 'apikey', key: 'K', value: 'v', in: 'header' });
    expect(named('Raw xml').body.mode).toBe('xml');
    expect(named('Raw xml').auth).toEqual({ type: 'bearer', token: 't' });
    expect(named('Ct xml').body.mode).toBe('xml');
    expect(named('Ct xml').auth).toEqual({ type: 'none' });
    expect(named('Raw text').body).toEqual({ mode: 'text', content: 'hi' });
    expect(named('Raw text').auth).toEqual({ type: 'inherit' });
    expect(named('Encoded').body).toEqual({
      mode: 'urlencoded',
      fields: [{ key: 'a', value: 'b' }],
    });
    expect(named('Form').body).toEqual({ mode: 'form', fields: [{ key: 'f', value: 'v' }] });
    expect(named('Graphql').body).toEqual({
      mode: 'json',
      content: '{"query":"{ a }","variables":"{\\"x\\":1}"}',
    });
    expect(named('Graphql bare').body).toEqual({ mode: 'json', content: '{"query":""}' });
    expect(named('Binary').body).toEqual({ mode: 'none' });
    expect(plain).toMatchObject({ method: 'GET', url: 'http://plain.test', query: [] });
    expect(plain).not.toHaveProperty('description');
    expect(odd).toMatchObject({
      method: 'GET',
      url: '',
      description: 'Plain doc',
      body: { mode: 'none' },
    });
    expect(query).toMatchObject({
      url: 'http://q.test/a/:id',
      query: [{ key: 'x', value: '1' }],
      pathParams: [{ key: 'id', value: '7' }],
    });
    expect(rawOnly).toMatchObject({ url: 'http://r.test?y=2', query: [] });
    expect(rawOnly).not.toHaveProperty('pathParams');
    expect(noAuth).toEqual({ id: expect.any(String), type: 'folder', name: 'No auth', items: [] });
  });

  it('defaults a document without info, items or auth', () => {
    expect(importPostman({ info: 'x' })).toEqual({
      name: 'Postman collection',
      variables: [],
      auth: { type: 'none' },
      items: [],
    });
  });
});

describe('exportPostman edge cases', () => {
  it('writes auth, bodies, scripts, folders and variables', () => {
    const exported = exportPostman({
      name: 'Out',
      description: 'Collection doc',
      variables: [
        { key: 's', value: 'secret', secret: true },
        { key: 'off', value: 'x', enabled: false },
      ],
      auth: { type: 'apikey', key: 'K', value: 'V', in: 'query' },
      items: [
        {
          id: 'f',
          type: 'folder',
          name: 'Folder',
          description: 'Folder doc',
          auth: { type: 'basic', username: 'u', password: 'p' },
          items: [
            request({
              name: 'Inner',
              body: { mode: 'text', content: 't' },
              auth: { type: 'bearer', token: 'tk' },
            }),
          ],
        },
        { id: 'g', type: 'folder', name: 'Plain', items: [] },
        request({
          name: 'Checks',
          description: 'Request doc',
          headers: [{ key: 'H', value: '1', enabled: false }],
          query: [
            { key: 'a', value: '1' },
            { key: 'b', value: '2', enabled: false },
          ],
          pathParams: [{ key: 'id', value: '3' }],
          body: {
            mode: 'urlencoded',
            fields: [
              { key: 'u', value: 'v', enabled: false },
              { key: 'w', value: 'x' },
            ],
          },
          auth: { type: 'none' },
          assertions: [
            { id: '1', source: 'status', operator: 'eq', expected: '2xx' },
            { id: '2', source: 'duration', operator: 'lt', expected: '100' },
            { id: '3', source: 'header', path: 'X-Id', operator: 'exists' },
            { id: '4', source: 'header', operator: 'notExists' },
            { id: '5', source: 'body', operator: 'contains', expected: 'ok' },
            { id: '6', source: 'body', operator: 'notContains' },
            { id: '7', source: 'json', path: '$.items[0].my-key', operator: 'neq', expected: 'x' },
            { id: '8', source: 'json', path: 'list.2', operator: 'lte', expected: '1' },
            { id: '9', source: 'json', operator: 'gt', expected: '1' },
            { id: '10', source: 'json', path: 'n', operator: 'gte', expected: '1' },
            { id: '11', source: 'json', path: 'n', operator: 'matches', expected: '^1' },
            { id: '12', source: 'json', path: 'n', operator: 'isType', expected: 'number' },
            { id: '13', source: 'status', operator: 'eq' },
          ],
          captures: [
            { variable: 'st', source: 'status' },
            { variable: 'h', source: 'header', path: 'X-Id' },
            { variable: 'hh', source: 'header' },
            { variable: 'b', source: 'body' },
            { variable: 'j', source: 'json', path: 'id' },
            { variable: 'jj', source: 'json' },
          ],
        }),
        request({
          name: 'Form',
          body: {
            mode: 'form',
            fields: [
              { key: 'f', value: 'v', enabled: false },
              { key: 'g', value: 'w' },
            ],
          },
        }),
        request({ name: 'Xml', body: { mode: 'xml', content: '<a/>' } }),
      ],
    });
    const info = exported['info'] as Record<string, unknown>;
    expect(info['description']).toBe('Collection doc');
    expect(exported['auth']).toEqual({
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'K', type: 'string' },
        { key: 'value', value: 'V', type: 'string' },
        { key: 'in', value: 'query', type: 'string' },
      ],
    });
    expect(exported['variable']).toEqual([
      { key: 's', value: '' },
      { key: 'off', value: 'x', disabled: true },
    ]);
    const [folder, plain, checks, form, xml] = exported['item'] as Record<string, any>[];
    expect(folder!['description']).toBe('Folder doc');
    expect(folder!['auth']['type']).toBe('basic');
    expect(folder!['item'][0]['request']['auth']).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: 'tk', type: 'string' }],
    });
    expect(folder!['item'][0]['request']['body']).toEqual({
      mode: 'raw',
      raw: 't',
      options: { raw: { language: 'text' } },
    });
    expect(folder!['item'][0]).not.toHaveProperty('event');
    expect(plain).toEqual({ name: 'Plain', item: [] });
    const req = checks!['request'];
    expect(req['description']).toBe('Request doc');
    expect(req['auth']).toEqual({ type: 'noauth' });
    expect(req['header']).toEqual([{ key: 'H', value: '1', disabled: true }]);
    expect(req['url']).toEqual({
      raw: '{{baseUrl}}/x?a=1',
      query: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', disabled: true },
      ],
      variable: [{ key: 'id', value: '3' }],
    });
    expect(req['body']).toEqual({
      mode: 'urlencoded',
      urlencoded: [
        { key: 'u', value: 'v', disabled: true },
        { key: 'w', value: 'x' },
      ],
    });
    const script = (checks!['event'][0]['script']['exec'] as string[]).join('\n');
    for (const line of [
      'pm.expect(String(pm.response.code)).to.eql("2xx");',
      'pm.expect(Number(pm.response.responseTime)).to.be.below(Number("100"));',
      'pm.expect(pm.response.headers.get("X-Id")).to.not.be.oneOf([undefined, null]);',
      'pm.expect(pm.response.headers.get("")).to.be.oneOf([undefined, null]);',
      'pm.expect(String(pm.response.text())).to.include("ok");',
      'pm.expect(String(pm.response.text())).to.not.include("");',
      'pm.expect(String(pm.response.json().items[0]["my-key"])).to.not.eql("x");',
      'pm.expect(Number(pm.response.json().list[2])).to.be.at.most(Number("1"));',
      'pm.expect(Number(pm.response.json())).to.be.above(Number("1"));',
      'pm.expect(Number(pm.response.json().n)).to.be.at.least(Number("1"));',
      'pm.expect(String(pm.response.json().n)).to.match(new RegExp("^1"));',
      'pm.expect(pm.response.json().n).to.be.a("number");',
      'pm.expect(String(pm.response.code)).to.eql("");',
      'pm.collectionVariables.set("st", String(pm.response.code));',
      'pm.collectionVariables.set("h", pm.response.headers.get("X-Id"));',
      'pm.collectionVariables.set("hh", pm.response.headers.get(""));',
      'pm.collectionVariables.set("b", pm.response.text());',
      'pm.collectionVariables.set("j", pm.response.json().id);',
      'pm.collectionVariables.set("jj", pm.response.json());',
    ]) {
      expect(script).toContain(line);
    }
    expect(form!['request']['body']).toEqual({
      mode: 'formdata',
      formdata: [
        { key: 'f', value: 'v', type: 'text', disabled: true },
        { key: 'g', value: 'w', type: 'text' },
      ],
    });
    expect(form!['request']).not.toHaveProperty('auth');
    expect(form!['request']['url']).toEqual({ raw: '{{baseUrl}}/x' });
    expect(xml!['request']['body']['options']).toEqual({ raw: { language: 'xml' } });
  });

  it('omits collection auth and description when inherited or absent', () => {
    const exported = exportPostman({
      name: 'Bare',
      variables: [],
      auth: { type: 'inherit' },
      items: [],
    });
    expect(exported).not.toHaveProperty('auth');
    expect(exported['info']).not.toHaveProperty('description');
  });
});
