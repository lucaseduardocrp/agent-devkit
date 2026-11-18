import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import type { ApiItem, ApiRequestSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';
import {
  ADK_CHECKS_MARKER,
  assertionsFromScript,
  capturesFromScript,
  exportPostman,
  exportPostmanEnvironment,
  importPostman,
  isPostmanCollection,
  scriptFor,
} from '../src/modules/apitests/formats/postman.js';

type Json = Record<string, unknown>;

const entries = (type: string, values: Record<string, unknown>) => ({
  type,
  [type]: Object.entries(values).map(([key, value]) => ({ key, value })),
});

const importItem = (item: Json): Json =>
  importPostman({ info: { name: 'C' }, item: [item] }).items[0] as unknown as Json;
const importRequest = (request: unknown, extra: Json = {}): ApiRequestSpec =>
  importItem({ name: 'R', request, ...extra }) as unknown as ApiRequestSpec;
const importAuth = (auth: unknown) => importRequest({ method: 'GET', url: 'u', auth }).auth;

describe('isPostmanCollection', () => {
  it('requires a Postman collection schema', () => {
    expect(
      isPostmanCollection({
        info: { schema: 'https://schema.postman.com/json/collection/v2.1.0/' },
      }),
    ).toBe(true);
    expect(isPostmanCollection({ info: { schema: 'other' } })).toBe(false);
    expect(isPostmanCollection({ info: 'x' })).toBe(false);
    expect(isPostmanCollection(null)).toBe(false);
  });
});

describe('Postman import', () => {
  it('uses defaults for an empty document', () => {
    expect(importPostman({})).toEqual({
      name: 'Postman collection',
      variables: [],
      auth: { type: 'none' },
      items: [],
    });
  });

  it('reads descriptions, collection scripts, auth and variables', () => {
    const imported = importPostman({
      info: { name: 'API', description: { content: 'Docs' } },
      variable: [{ key: 'a', value: 1, disabled: true }, 'junk'],
      auth: entries('bearer', { token: 't' }),
      event: [
        { listen: 'prerequest', script: { exec: ['pm.a()', 'pm.b()'] } },
        { listen: 'test', script: { exec: 'pm.test()' } },
        { listen: 'prerequest', script: 'invalid' },
      ],
      item: [{ name: 'only objects' }, 'junk'],
    });
    expect(imported).toMatchObject({
      name: 'API',
      description: 'Docs',
      variables: [{ key: 'a', value: '1', enabled: false }],
      auth: { type: 'bearer', token: 't' },
      scripts: { preRequest: 'adk.a()\nadk.b()', postResponse: 'adk.test()' },
    });
    expect(importPostman({ info: { description: 'plain' } }).description).toBe('plain');
  });

  it('reads folders with auth, variables and scripts', () => {
    const folder = importItem({
      name: '',
      description: 'Folder docs',
      auth: entries('basic', { username: 'u', password: 'p' }),
      variable: [{ key: 'v', value: 'x' }],
      event: [{ listen: 'prerequest', script: { exec: ['pm.x()'] } }],
      item: [{ name: 'Child', request: { method: 'get', url: 'http://x' } }],
    });
    expect(folder).toMatchObject({
      type: 'folder',
      name: 'Untitled',
      description: 'Folder docs',
      auth: { type: 'basic' },
      vars: [{ key: 'v', value: 'x' }],
      scripts: { preRequest: 'adk.x()' },
    });
    expect((folder['items'] as Json[])[0]).toMatchObject({ name: 'Child', url: 'http://x' });
    expect(importItem({ name: 'Plain', item: [] })).not.toHaveProperty('auth');
  });

  it('reads requests from strings, objects and URLs', () => {
    expect(importItem({ name: 'S', request: 'http://s.test' })).toMatchObject({
      url: 'http://s.test',
      method: 'GET',
    });
    expect(importItem({ name: 'N' })).toMatchObject({ url: '', method: 'GET' });
    expect(importRequest({ url: 5 }).url).toBe('');
    expect(importRequest({ method: 'weird', url: { raw: 'http://u' } }).method).toBe('GET');
    const full = importRequest({
      method: 'post',
      description: 'Request docs',
      header: [{ key: 'X', value: 'y', disabled: true }],
      url: {
        raw: 'http://u/{{id}}?a=1',
        query: [{ key: 'a', value: '1' }],
        variable: [{ key: 'id', value: '7' }],
      },
    });
    expect(full).toMatchObject({
      method: 'POST',
      description: 'Request docs',
      url: 'http://u/{{id}}',
      query: [{ key: 'a', value: '1' }],
      pathParams: [{ key: 'id', value: '7' }],
      headers: [{ key: 'X', value: 'y', enabled: false }],
    });
    expect(
      importItem({ name: 'D', description: { content: 'Item docs' }, request: { url: 'u' } }),
    ).toMatchObject({ description: 'Item docs' });
    expect(importRequest({ url: { raw: 'http://u?x=1' } }).url).toBe('http://u?x=1');
  });

  it('reads body modes', () => {
    const bodyOf = (body: unknown, header: Json[] = []) =>
      importRequest({ url: 'u', header, body }).body;
    expect(bodyOf(undefined)).toEqual({ mode: 'none' });
    expect(bodyOf({ mode: 'unknown' })).toEqual({ mode: 'none' });
    expect(bodyOf({ mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } })).toEqual({
      mode: 'json',
      content: '{}',
    });
    expect(bodyOf({ mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } }).mode).toBe(
      'xml',
    );
    expect(
      bodyOf({ mode: 'raw', raw: '{}' }, [{ key: 'Content-Type', value: 'application/json' }]).mode,
    ).toBe('json');
    expect(
      bodyOf({ mode: 'raw', raw: '<a/>' }, [{ key: 'content-type', value: 'text/xml' }]).mode,
    ).toBe('xml');
    expect(bodyOf({ mode: 'raw', raw: 'hi', options: { raw: 'bad' } })).toEqual({
      mode: 'text',
      content: 'hi',
    });
    expect(bodyOf({ mode: 'raw', raw: 'hi', options: {} })).toEqual({
      mode: 'text',
      content: 'hi',
    });
    expect(bodyOf({ mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] })).toEqual({
      mode: 'urlencoded',
      fields: [{ key: 'a', value: '1' }],
    });
    expect(bodyOf({ mode: 'file' })).toEqual({ mode: 'binary', file: null });
    expect(
      bodyOf({
        mode: 'formdata',
        formdata: [
          { key: 'f', type: 'file', src: ['C:\\x\\a.png', '', '/y/b.png'] },
          { key: 'g', type: 'file', src: 'single.txt', contentType: 'ignored' },
          { key: 'h', type: 'file' },
          { key: 't', value: 'v', contentType: 'text/plain', disabled: true },
          { key: 'u', value: 'v' },
          'junk',
        ],
      }),
    ).toEqual({
      mode: 'form',
      fields: [
        { key: 'f', value: 'a.png, b.png', type: 'text' },
        { key: 'g', value: 'single.txt', type: 'text' },
        { key: 'h', value: '', type: 'text' },
        { key: 't', value: 'v', type: 'text', enabled: false, contentType: 'text/plain' },
        { key: 'u', value: 'v', type: 'text' },
      ],
    });
  });

  it('reads GraphQL bodies', () => {
    const graphql = (body: Json) => importRequest({ url: 'u', body: { mode: 'graphql', ...body } });
    expect(graphql({ graphql: { query: '{ a }', variables: '{"x":1}' } })).toMatchObject({
      kind: 'graphql',
      body: { mode: 'none' },
      graphql: { query: '{ a }', variables: '{"x":1}' },
    });
    expect(graphql({ graphql: { query: 'q', variables: { x: 1 } } }).graphql!.variables).toContain(
      '"x": 1',
    );
    expect(graphql({ graphql: { query: 'q' } }).graphql).toEqual({ query: 'q' });
    expect(graphql({ graphql: { query: 'q', variables: '  ' } }).graphql).toEqual({ query: 'q' });
    expect(graphql({}).graphql).toEqual({ query: '' });
  });

  it('reads scripts, checks, captures and settings', () => {
    const item = importItem({
      name: 'R',
      request: { url: 'u' },
      variable: [{ key: 'v', value: '1' }],
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              'pm.test("own", () => {});',
              ADK_CHECKS_MARKER,
              'pm.response.to.have.status(201);',
              'pm.collectionVariables.set("id", pm.response.json().data.id);',
            ],
          },
        },
      ],
      protocolProfileBehavior: {
        followRedirects: false,
        maxRedirects: 3,
        disableUrlEncoding: true,
      },
    });
    expect(item).toMatchObject({
      vars: [{ key: 'v', value: '1' }],
      scripts: { postResponse: 'adk.test("own", () => {});' },
      assertions: [{ source: 'status', operator: 'eq', expected: '201' }],
      captures: [{ variable: 'id', source: 'json', path: 'data.id' }],
      settings: { followRedirects: false, maxRedirects: 3, encodeUrl: false },
    });
    const plain = importItem({ name: 'P', request: { url: 'u' }, protocolProfileBehavior: {} });
    expect(plain).not.toHaveProperty('settings');
    expect(
      importItem({ name: 'P', request: { url: 'u' }, protocolProfileBehavior: 'x' }),
    ).not.toHaveProperty('settings');
    expect(
      importItem({
        name: 'P',
        request: { url: 'u' },
        protocolProfileBehavior: {
          followRedirects: 'yes',
          maxRedirects: '3',
          disableUrlEncoding: false,
        },
      }),
    ).not.toHaveProperty('settings');
    const generatedOnly = importItem({
      name: 'G',
      request: { url: 'u' },
      event: [
        {
          listen: 'test',
          script: { exec: [ADK_CHECKS_MARKER, 'pm.response.to.have.status(200);'] },
        },
      ],
    });
    expect(generatedOnly).not.toHaveProperty('scripts');
  });

  it('maps authentication types', () => {
    expect(importAuth(undefined)).toEqual({ type: 'inherit' });
    expect(importAuth({ type: 'noauth' })).toEqual({ type: 'none' });
    expect(importAuth({ type: 'ntlm' })).toEqual({ type: 'none' });
    expect(importAuth({ type: 'hawk' })).toEqual({ type: 'inherit' });
    expect(importAuth({ type: 'bearer' })).toEqual({ type: 'bearer', token: '' });
    expect(importAuth(entries('digest', { username: 'u', password: 'p' }))).toEqual({
      type: 'digest',
      username: 'u',
      password: 'p',
    });
    expect(importAuth(entries('basic', { username: 'u', password: 'p' }))).toMatchObject({
      type: 'basic',
    });
    expect(importAuth(entries('apikey', { key: 'k', value: 'v', in: 'query' }))).toEqual({
      type: 'apikey',
      key: 'k',
      value: 'v',
      in: 'query',
    });
    expect(importAuth(entries('apikey', { value: 'v' }))).toMatchObject({
      key: 'X-API-Key',
      in: 'header',
    });
    expect(
      importAuth(
        entries('awsv4', {
          accessKey: 'a',
          secretKey: 's',
          sessionToken: 't',
          service: 'sv',
          region: 'r',
        }),
      ),
    ).toEqual({
      type: 'awsv4',
      accessKeyId: 'a',
      secretAccessKey: 's',
      sessionToken: 't',
      service: 'sv',
      region: 'r',
    });
    expect(importAuth(entries('awsv4', { accessKey: 'a' }))).not.toHaveProperty('sessionToken');
  });

  it('maps OAuth 1, OAuth 2 and EdgeGrid authentication', () => {
    expect(
      importAuth(
        entries('oauth1', {
          consumerKey: 'k',
          consumerSecret: 's',
          token: 't',
          tokenSecret: 'ts',
          signatureMethod: 'PLAINTEXT',
          realm: 'r',
          addParamsToHeader: 'false',
        }),
      ),
    ).toEqual({
      type: 'oauth1',
      consumerKey: 'k',
      consumerSecret: 's',
      token: 't',
      tokenSecret: 'ts',
      signatureMethod: 'PLAINTEXT',
      realm: 'r',
      addTo: 'query',
    });
    expect(importAuth(entries('oauth1', { signatureMethod: 'HMAC-SHA256' }))).toMatchObject({
      signatureMethod: 'HMAC-SHA256',
      addTo: 'header',
    });
    expect(importAuth(entries('oauth1', { signatureMethod: 'RSA-SHA1' }))).toMatchObject({
      signatureMethod: 'HMAC-SHA1',
    });
    expect(importAuth(entries('oauth2', { grant_type: 'authorization_code' }))).toEqual({
      type: 'none',
    });
    expect(
      importAuth(
        entries('oauth2', {
          grant_type: 'password_credentials',
          accessTokenUrl: 'u',
          clientId: 'c',
          clientSecret: 's',
          username: 'user',
          password: 'pw',
          scope: 'sc',
          client_authentication: 'body',
          addTokenTo: 'queryParams',
          headerPrefix: 'Token',
        }),
      ),
    ).toEqual({
      type: 'oauth2',
      grantType: 'password',
      accessTokenUrl: 'u',
      clientId: 'c',
      clientSecret: 's',
      username: 'user',
      password: 'pw',
      scope: 'sc',
      credentialsPlacement: 'body',
      tokenPlacement: 'query',
    });
    expect(importAuth(entries('oauth2', { headerPrefix: 'Token' }))).toMatchObject({
      grantType: 'client_credentials',
      credentialsPlacement: 'basic',
      tokenPlacement: 'header',
      tokenPrefix: 'Token',
    });
    expect(importAuth(entries('oauth2', {}))).not.toHaveProperty('tokenPrefix');
    expect(
      importAuth(
        entries('edgegrid', {
          accessToken: 'a',
          clientToken: 'c',
          clientSecret: 's',
          headersToSign: 'h',
          maxBodySize: '2048',
        }),
      ),
    ).toEqual({
      type: 'edgegrid',
      accessToken: 'a',
      clientToken: 'c',
      clientSecret: 's',
      headersToSign: 'h',
      maxBodySize: 2048,
    });
    expect(importAuth(entries('edgegrid', {}))).not.toHaveProperty('maxBodySize');
  });
});

describe('Postman scripts to checks', () => {
  it('recognizes the status, duration and header idioms', () => {
    const script = [
      'pm.response.to.have.status(404)',
      'pm.expect(pm.response.code).to.eql(201)',
      'pm.expect(pm.response.code).to.equal(202)',
      'pm.expect(pm.response.responseTime).to.be.below(500)',
      "pm.response.to.have.header( 'X-Id' )",
    ].join('\n');
    expect(
      assertionsFromScript(script).map((a) => [a.source, a.path, a.operator, a.expected]),
    ).toEqual([
      ['status', undefined, 'eq', '404'],
      ['status', undefined, 'eq', '201'],
      ['status', undefined, 'eq', '202'],
      ['duration', undefined, 'lt', '500'],
      ['header', 'X-Id', 'exists', undefined],
    ]);
  });

  it('recognizes variables captured from JSON', () => {
    const script = [
      'pm.environment.set("a", pm.response.json().data.items[0].id)',
      "pm.variables.set('b', jsonData['odd key'].x)",
      'pm.globals.set("c", body.name)',
      'pm.environment.set("d", unrelated())',
    ].join('\n');
    expect(capturesFromScript(script)).toEqual([
      { variable: 'a', source: 'json', path: 'data.items[0].id' },
      { variable: 'b', source: 'json', path: 'odd key.x' },
      { variable: 'c', source: 'json', path: 'name' },
    ]);
  });
});

const request = (extra: Partial<ApiRequestSpec> = {}): ApiRequestSpec =>
  ({
    id: 'r',
    type: 'request',
    name: 'Req',
    method: 'GET',
    url: 'http://x/y',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
    ...extra,
  }) as ApiRequestSpec;

const collectionOf = (items: ApiItem[], extra: Json = {}): CollectionInput =>
  ({
    name: 'C',
    variables: [],
    auth: { type: 'none' },
    items,
    ...extra,
  }) as unknown as CollectionInput;

const exportedItem = (extra: Partial<ApiRequestSpec>): Json =>
  (exportPostman(collectionOf([request(extra)]))['item'] as Json[])[0]!;
const requestPart = (extra: Partial<ApiRequestSpec>) => exportedItem(extra)['request'] as Json;

describe('Postman script generation', () => {
  it('writes a check for every source and operator', () => {
    const operators = [
      'eq',
      'neq',
      'contains',
      'notContains',
      'exists',
      'notExists',
      'lt',
      'lte',
      'gt',
      'gte',
      'matches',
      'isType',
    ] as const;
    const lines = scriptFor(
      request({
        assertions: [
          ...operators.map((operator) => ({
            id: operator,
            source: 'json',
            path: 'data.items[0]["odd key"].2',
            operator,
            expected: '5',
          })),
          { id: 'a', source: 'status', operator: 'eq', expected: '200' },
          { id: 'b', source: 'status', operator: 'eq', expected: 'abc' },
          { id: 'c', source: 'status', operator: 'neq' },
          { id: 'c2', source: 'status', operator: 'eq' },
          { id: 'c3', source: 'json', operator: 'exists', path: 'odd-key.x' },
          { id: 'd', source: 'duration', operator: 'lt', expected: '100' },
          { id: 'e', source: 'header', operator: 'exists', path: 'X-A' },
          { id: 'f', source: 'header', operator: 'exists' },
          { id: 'g', source: 'body', operator: 'contains', expected: 'x' },
          { id: 'h', source: 'json', operator: 'exists' },
          { id: 'i', source: 'json', operator: 'exists', path: '$.a' },
        ] as never,
      }),
    ).join('\n');
    expect(lines).toContain('pm.response.to.have.status(200);');
    expect(lines).toContain('pm.response.code');
    expect(lines).toContain('pm.response.responseTime');
    expect(lines).toContain('pm.response.headers.get("X-A")');
    expect(lines).toContain('pm.response.headers.get("")');
    expect(lines).toContain('pm.response.text()');
    expect(lines).toContain('.data.items[0]["odd key"][2]');
    expect(lines).toContain('pm.expect(String(pm.response.code)).to.eql("abc");');
    expect(lines).toContain('pm.response.json().a');
    expect(lines).toContain('pm.response.json()["odd-key"].x');
    expect(lines).toContain('to.match(new RegExp("5"))');
  });

  it('writes captures from every source', () => {
    const lines = scriptFor(
      request({
        captures: [
          { variable: 's', source: 'status' },
          { variable: 'h', source: 'header', path: 'X-H' },
          { variable: 'n', source: 'header' },
          { variable: 'b', source: 'body' },
          { variable: 'j', source: 'json', path: 'a' },
          { variable: 'k', source: 'json' },
        ] as never,
      }),
    ).join('\n');
    expect(lines).toContain('pm.collectionVariables.set("s", String(pm.response.code));');
    expect(lines).toContain('pm.response.headers.get("X-H")');
    expect(lines).toContain('pm.collectionVariables.set("b", pm.response.text());');
    expect(lines).toContain('pm.collectionVariables.set("j", pm.response.json().a);');
  });
});

describe('Postman export', () => {
  it('exports the collection with variables, scripts and auth', () => {
    const file = exportPostman(
      collectionOf([], {
        description: 'Docs',
        variables: [
          { key: 'a', value: '1' },
          { key: 's', value: 'secret', secret: true },
          { key: 'off', value: 'x', enabled: false },
        ],
        auth: { type: 'bearer', token: 't' },
        scripts: { preRequest: 'adk.a()', postResponse: 'adk.b()', tests: 'adk.c()' },
      }),
    );
    expect((file['info'] as Json)['description']).toBe('Docs');
    expect(file['variable']).toEqual([
      { key: 'a', value: '1' },
      { key: 's', value: '' },
      { key: 'off', value: 'x', disabled: true },
    ]);
    expect(file['auth']).toMatchObject({ type: 'bearer' });
    expect(file['event']).toEqual([
      { listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.a()'] } },
      { listen: 'test', script: { type: 'text/javascript', exec: ['pm.b()', 'pm.c()'] } },
    ]);
    const plain = exportPostman(collectionOf([], { auth: { type: 'inherit' } }));
    expect(plain).not.toHaveProperty('auth');
    expect(plain).not.toHaveProperty('event');
    expect(plain['info']).not.toHaveProperty('description');
  });

  it('exports folders and skips request kinds Postman cannot hold', () => {
    const file = exportPostman(
      collectionOf([
        {
          id: 'f',
          type: 'folder',
          name: 'F',
          description: 'Notes',
          auth: { type: 'none' },
          vars: [{ key: 'v', value: '1', enabled: false }],
          scripts: { preRequest: 'adk.x()' },
          items: [
            request({ kind: 'grpc' }),
            request({ kind: 'websocket' }),
            request({ kind: 'socket' }),
            request({ name: 'Kept' }),
          ],
        } as ApiItem,
        { id: 'g', type: 'folder', name: 'G', items: [] } as ApiItem,
        request({ kind: 'http', name: 'http' }),
      ]),
    );
    const [folder, bare, top] = file['item'] as Json[];
    expect(folder).toMatchObject({
      description: 'Notes',
      auth: { type: 'noauth' },
      variable: [{ key: 'v', value: '1', disabled: true }],
    });
    expect((folder!['item'] as Json[]).map((item) => item['name'])).toEqual(['Kept']);
    expect(bare).not.toHaveProperty('description');
    expect(bare).not.toHaveProperty('variable');
    expect(top!['name']).toBe('http');
  });

  it('exports requests with queries, path parameters, variables and settings', () => {
    const item = exportedItem({
      description: 'Docs',
      vars: [{ key: 'v', value: '1' }],
      query: [
        { key: 'a', value: '1' },
        { key: 'b', value: '2', enabled: false },
      ],
      pathParams: [{ key: 'id', value: '7' }],
      settings: { followRedirects: true, maxRedirects: 2, encodeUrl: false },
    });
    expect(item['protocolProfileBehavior']).toEqual({
      followRedirects: true,
      maxRedirects: 2,
      disableUrlEncoding: true,
    });
    expect(item['variable']).toEqual([{ key: 'v', value: '1' }]);
    expect(item['request']).toMatchObject({
      description: 'Docs',
      url: {
        raw: 'http://x/y?a=1',
        query: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2', disabled: true },
        ],
        variable: [{ key: 'id', value: '7' }],
      },
    });
    expect(requestPart({ query: [{ key: 'b', value: '2', enabled: false }] })).toMatchObject({
      url: { raw: 'http://x/y' },
    });
    expect(exportedItem({ settings: {} })).not.toHaveProperty('protocolProfileBehavior');
    expect(exportedItem({ settings: { encodeUrl: true } })).not.toHaveProperty(
      'protocolProfileBehavior',
    );
  });

  it('exports each body mode', () => {
    const body = (value: ApiRequestSpec['body']) => requestPart({ body: value })['body'] as Json;
    expect(requestPart({})).not.toHaveProperty('body');
    expect(body({ mode: 'json', content: '{}' })).toMatchObject({
      options: { raw: { language: 'json' } },
    });
    expect(body({ mode: 'xml', content: '<a/>' })).toMatchObject({
      options: { raw: { language: 'xml' } },
    });
    expect(body({ mode: 'text', content: 'x' })).toMatchObject({
      options: { raw: { language: 'text' } },
    });
    expect(body({ mode: 'sparql', content: 'x' })).toMatchObject({
      options: { raw: { language: 'text' } },
    });
    expect(
      body({ mode: 'urlencoded', fields: [{ key: 'a', value: '1', enabled: false }] }),
    ).toMatchObject({
      mode: 'urlencoded',
      urlencoded: [{ key: 'a', value: '1', disabled: true }],
    });
    expect(
      body({
        mode: 'form',
        fields: [
          {
            key: 'f',
            value: 'name.png',
            type: 'file',
            file: { fileName: 'a.png' },
            contentType: 'image/png',
          },
          { key: 'g', value: 'name.txt', type: 'file' },
          { key: 't', value: 'v', type: 'text', enabled: false },
        ],
      } as never)['formdata'],
    ).toEqual([
      { key: 'f', type: 'file', src: 'a.png', contentType: 'image/png' },
      { key: 'g', type: 'file', src: 'name.txt' },
      { key: 't', value: 'v', type: 'text', disabled: true },
    ]);
    expect(body({ mode: 'binary', file: { fileName: 'b.bin' } } as never)['file']).toEqual({
      src: 'b.bin',
    });
    expect(body({ mode: 'binary', file: null })['file']).toEqual({ src: '' });
    expect(
      requestPart({ kind: 'graphql', graphql: { query: '{ a }', variables: '{}' } })['body'],
    ).toEqual({ mode: 'graphql', graphql: { query: '{ a }', variables: '{}' } });
    expect(requestPart({ kind: 'graphql', graphql: { query: '{ a }' } })['body']).toEqual({
      mode: 'graphql',
      graphql: { query: '{ a }', variables: '' },
    });
    expect(requestPart({ kind: 'graphql' })).not.toHaveProperty('body');
  });

  it('exports each authentication type', () => {
    const auth = (value: RequestAuth) => requestPart({ auth: value })['auth'] as Json;
    expect(requestPart({})).not.toHaveProperty('auth');
    expect(auth({ type: 'none' })).toEqual({ type: 'noauth' });
    expect(auth({ type: 'wsse' } as never)).toEqual({ type: 'noauth' });
    expect(auth({ type: 'bearer', token: 't' })).toMatchObject({ type: 'bearer' });
    expect(auth({ type: 'basic', username: 'u', password: 'p' })).toMatchObject({ type: 'basic' });
    expect(auth({ type: 'digest', username: 'u', password: 'p' })).toMatchObject({
      type: 'digest',
    });
    expect(auth({ type: 'apikey', key: 'k', value: 'v', in: 'query' })).toMatchObject({
      type: 'apikey',
    });
    expect(
      auth({ type: 'awsv4', accessKeyId: 'a', secretAccessKey: 's', service: 'x', region: 'y' }),
    ).toMatchObject({ type: 'awsv4' });
    expect(
      (
        auth({
          type: 'awsv4',
          accessKeyId: 'a',
          secretAccessKey: 's',
          sessionToken: 't',
          service: 'x',
          region: 'y',
        })['awsv4'] as Json[]
      ).some((entry) => entry['key'] === 'sessionToken'),
    ).toBe(true);
    const oauth1 = (addTo?: 'query' | 'header') =>
      auth({
        type: 'oauth1',
        consumerKey: 'k',
        consumerSecret: 's',
        signatureMethod: 'HMAC-SHA1',
        ...(addTo ? { addTo } : {}),
      } as never)['oauth1'] as { key: string; value: unknown }[];
    expect(oauth1('query').find((entry) => entry.key === 'addParamsToHeader')!.value).toBe(false);
    expect(oauth1().find((entry) => entry.key === 'addParamsToHeader')!.value).toBe(true);
    const oauth2 = (extra: Json) =>
      auth({
        type: 'oauth2',
        grantType: 'client_credentials',
        accessTokenUrl: 'u',
        clientId: 'c',
        clientSecret: 's',
        ...extra,
      } as never)['oauth2'] as { key: string; value: unknown }[];
    const value = (list: { key: string; value: unknown }[], key: string) =>
      list.find((entry) => entry.key === key)?.value;
    expect(
      value(
        oauth2({ credentialsPlacement: 'basic', tokenPlacement: 'query' }),
        'client_authentication',
      ),
    ).toBe('header');
    expect(
      value(oauth2({ credentialsPlacement: 'basic', tokenPlacement: 'query' }), 'addTokenTo'),
    ).toBe('queryParams');
    expect(value(oauth2({ credentialsPlacement: 'body' }), 'client_authentication')).toBe('body');
    expect(value(oauth2({}), 'addTokenTo')).toBe('header');
    expect(
      value(oauth2({ grantType: 'password', username: 'a', password: 'b' }), 'grant_type'),
    ).toBe('password_credentials');
    expect(value(oauth2({ grantType: 'password', username: 'a', password: 'b' }), 'username')).toBe(
      'a',
    );
    expect(value(oauth2({}), 'username')).toBeUndefined();
    expect(
      auth({
        type: 'edgegrid',
        accessToken: 'a',
        clientToken: 'c',
        clientSecret: 's',
        headersToSign: 'h',
        maxBodySize: 10,
      }),
    ).toMatchObject({ type: 'edgegrid' });
    const folder = (
      exportPostman(
        collectionOf([
          { id: 'f', type: 'folder', name: 'F', auth: { type: 'inherit' }, items: [] } as ApiItem,
        ]),
      )['item'] as Json[]
    )[0]!;
    expect(folder).not.toHaveProperty('auth');
  });

  it('exports scripts and generated checks on requests', () => {
    const item = exportedItem({
      scripts: { preRequest: 'adk.pre()', postResponse: 'adk.post()' },
      assertions: [{ id: 'a', source: 'status', operator: 'eq', expected: '200' }] as never,
    });
    const events = item['event'] as { listen: string; script: { exec: string[] } }[];
    expect(events[0]!.script.exec).toEqual(['pm.pre()']);
    expect(events[1]!.script.exec).toEqual([
      'pm.post()',
      ADK_CHECKS_MARKER,
      expect.stringContaining('pm.test('),
      '  pm.response.to.have.status(200);',
      '});',
    ]);
    expect(exportedItem({ scripts: { tests: 'adk.only()' } })['event']).toHaveLength(1);
    expect(exportedItem({})).not.toHaveProperty('event');
  });

  it('exports environments hiding secrets', () => {
    const environment = exportPostmanEnvironment({
      name: 'Prod',
      variables: [
        { key: 'a', value: '1' },
        { key: 's', value: 'secret', secret: true, enabled: false },
      ],
    });
    expect(environment['values']).toEqual([
      { key: 'a', value: '1', type: 'default', enabled: true },
      { key: 's', value: '', type: 'secret', enabled: false },
    ]);
  });
});
