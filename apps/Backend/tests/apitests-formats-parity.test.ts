import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import { flattenRequests } from '../src/modules/apitests/engine/collection-runner.js';
import type {
  ApiFolder,
  ApiRequestSpec,
  RequestAuth,
} from '../src/modules/apitests/engine/types.js';
import {
  exportBruno,
  importBruno,
  parseBru,
  requestFromBru,
} from '../src/modules/apitests/formats/bruno.js';
import {
  detectFormat,
  exportAdk,
  exportInsomnia,
  exportPostman,
  importCollection,
  sourceKindOf,
} from '../src/modules/apitests/formats/index.js';
import { INSOMNIA_SCRIPT_NOTE } from '../src/modules/apitests/formats/insomnia.js';
import { exportK6 } from '../src/modules/apitests/formats/k6.js';

const base = {
  type: 'request' as const,
  method: 'GET' as const,
  headers: [],
  query: [],
  body: { mode: 'none' as const },
  auth: { type: 'inherit' as const },
  assertions: [],
  captures: [],
};

const request = (id: string, extra: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  ...base,
  id,
  name: id,
  url: `{{baseUrl}}/${id}`,
  ...extra,
});

const AUTHS: Record<string, RequestAuth> = {
  basic: { type: 'basic', username: 'u', password: 'p' },
  apikey: { type: 'apikey', key: 'api_key', value: '{{key}}', in: 'query' },
  digest: { type: 'digest', username: 'du', password: 'dp' },
  wsse: { type: 'wsse', username: 'wu', password: 'wp' },
  awsv4: {
    type: 'awsv4',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    sessionToken: 'ST',
    service: 'execute-api',
    region: 'eu-west-1',
  },
  oauth1: {
    type: 'oauth1',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    token: 'tk',
    tokenSecret: 'ts',
    signatureMethod: 'HMAC-SHA256',
    realm: 'photos',
    addTo: 'query',
  },
  oauth2: {
    type: 'oauth2',
    grantType: 'password',
    accessTokenUrl: 'https://auth.test/token',
    clientId: 'cid',
    clientSecret: 'csecret',
    username: 'ou',
    password: 'op',
    scope: 'read write',
    credentialsPlacement: 'basic',
    tokenPlacement: 'query',
    tokenQueryKey: 'token',
  },
  edgegrid: {
    type: 'edgegrid',
    clientToken: 'ct',
    clientSecret: 'cs',
    accessToken: 'at',
    headersToSign: 'X-A,X-B',
    maxBodySize: 2048,
  },
  none: { type: 'none' },
};

const rich: CollectionInput = {
  name: 'Parity',
  description: 'All the things',
  variables: [
    { key: 'baseUrl', value: 'https://api.test' },
    { key: 'secretKey', value: 'do-not-export', secret: true },
  ],
  auth: {
    type: 'oauth2',
    grantType: 'client_credentials',
    accessTokenUrl: 'https://auth.test/token',
    clientId: 'client',
    clientSecret: 'secret',
    scope: 'read',
    tokenPrefix: 'Token',
  },
  headers: [{ key: 'X-Collection', value: 'yes' }],
  scripts: {
    preRequest: 'adk.setVar("started", Date.now());',
    postResponse: 'console.log("done");',
    tests: 'test("collection", () => expect(res.status).to.be.below(500));',
  },
  scriptFlow: 'sequential',
  settings: {
    proxy: {
      enabled: true,
      protocol: 'socks5',
      hostname: 'proxy.test',
      port: 1080,
      username: 'proxy-user',
      password: 'proxy-pass',
      bypass: 'localhost',
    },
    clientCertificates: [
      { domain: '*.mtls.test', type: 'pem', cert: 'CERT', key: 'KEY' },
      { domain: 'pfx.test', type: 'pfx', pfx: 'PFX', passphrase: 'pw' },
    ],
    presets: { kind: 'graphql', baseUrl: 'https://api.test' },
  },
  protoFiles: [{ name: 'orders/v1/orders.proto', content: 'syntax = "proto3";' }],
  items: [
    {
      id: 'folder',
      type: 'folder',
      name: 'Folder',
      description: 'Folder docs',
      auth: AUTHS['awsv4'],
      headers: [{ key: 'X-Folder', value: '1' }],
      vars: [{ key: 'folderVar', value: 'f' }],
      scripts: { preRequest: 'console.log("folder");', tests: 'test("f", () => {});' },
      items: [
        request('create', {
          method: 'POST',
          description: 'Creates\nan order',
          headers: [{ key: 'Content-Type', value: 'application/json' }],
          query: [{ key: 'dry run', value: 'true', enabled: false }],
          body: { mode: 'json', content: '{\n  "a": 1\n}' },
          auth: AUTHS['digest']!,
          vars: [{ key: 'reqVar', value: 'r' }],
          scripts: {
            preRequest: 'req.setHeader("X-Pre", "1");',
            postResponse: 'adk.setVar("x", res.body.x);',
            tests: 'test("ok", () => expect(res.status).to.equal(201));',
          },
          tags: ['smoke', 'orders api'],
          settings: { encodeUrl: false, followRedirects: false, maxRedirects: 3 },
          timeoutMs: 5000,
          assertions: [
            { id: '1', source: 'status', operator: 'eq', expected: '201' },
            { id: '2', source: 'json', path: 'data.id', operator: 'exists' },
            {
              id: '3',
              source: 'json',
              path: 'data.items[0].name',
              operator: 'contains',
              expected: 'pen',
            },
            {
              id: '4',
              source: 'header',
              path: 'Content-Type',
              operator: 'matches',
              expected: 'json',
            },
            { id: '5', source: 'duration', operator: 'lt', expected: '800' },
            { id: '6', source: 'json', path: 'data.total', operator: 'gte', expected: '1' },
            { id: '7', source: 'json', path: 'data.items', operator: 'isType', expected: 'array' },
            { id: '8', source: 'json', path: 'data.deleted', operator: 'notExists' },
            { id: '9', source: 'json', path: 'data.state', operator: 'neq', expected: 'failed' },
            { id: '10', source: 'json', path: 'data.note', operator: 'notContains', expected: 'x' },
            { id: '11', source: 'json', path: 'data.total', operator: 'lte', expected: '10' },
            { id: '12', source: 'json', path: 'data.total', operator: 'gt', expected: '0' },
            { id: '13', source: 'json', path: 'data', operator: 'isType', expected: 'object' },
            { id: '14', source: 'body', operator: 'contains', expected: 'id' },
          ],
          captures: [
            { variable: 'orderId', source: 'json', path: 'data.id' },
            { variable: 'location', source: 'header', path: 'location' },
            { variable: 'code', source: 'status' },
            { variable: 'raw', source: 'body' },
          ],
        }),
        request('graphql', {
          kind: 'graphql',
          method: 'POST',
          graphql: {
            query: 'query Orders($first: Int) {\n  orders(first: $first) { id }\n}',
            variables: '{\n  "first": 10\n}',
            operationName: 'Orders',
          },
        }),
      ],
    },
    request('grpc', {
      kind: 'grpc',
      method: 'POST',
      url: 'grpcs://grpc.test:443',
      headers: [{ key: 'x-tenant', value: 'acme' }],
      auth: { type: 'bearer', token: '{{token}}' },
      grpc: {
        method: 'orders.v1.Orders/Create',
        protoFile: 'orders/v1/orders.proto',
        message: '[{"id": 1}, {"id": 2}]',
      },
    }),
    request('ws', {
      kind: 'websocket',
      url: 'wss://ws.test/chat',
      websocket: { messages: [{ name: 'hello', content: '{"hi":1}', type: 'json' }] },
    }),
    request('sse', { kind: 'sse', url: 'https://api.test/events', sse: { listenMs: 1000 } }),
    request('socket', {
      kind: 'socket',
      url: 'tcp://127.0.0.1:7',
      socket: { messages: [{ content: 'ping' }] },
    }),
    ...Object.entries(AUTHS).map(([name, auth]) => request(`auth-${name}`, { auth })),
    request('urlencoded', {
      method: 'POST',
      body: {
        mode: 'urlencoded',
        fields: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2', enabled: false },
        ],
      },
    }),
    request('multipart', {
      method: 'POST',
      body: {
        mode: 'form',
        fields: [
          { key: 'meta', value: '{"a":1}', contentType: 'application/json' },
          { key: 'file', value: '', type: 'file', file: { fileName: 'cat.png', data: 'AAAA' } },
        ],
      },
    }),
    request('binary', {
      method: 'PUT',
      body: {
        mode: 'binary',
        file: { fileName: 'blob.bin', contentType: 'application/octet-stream', data: 'AAAA' },
      },
    }),
    request('xml', { method: 'POST', body: { mode: 'xml', content: '<a/>' } }),
    request('text', { method: 'POST', body: { mode: 'text', content: 'hello' } }),
    request('sparql', { method: 'POST', body: { mode: 'sparql', content: 'SELECT * WHERE {}' } }),
  ],
};

const byName = (input: CollectionInput) =>
  Object.fromEntries(flattenRequests(input).map((flat) => [flat.request.name, flat.request]));

describe('Bruno round trip', () => {
  const files = exportBruno(rich, [
    {
      name: 'Prod',
      variables: [
        { key: 'baseUrl', value: 'https://prod.test' },
        { key: 'token', value: 'abc', secret: true },
      ],
    },
  ]);
  const content = (suffix: string) => files.find((file) => file.path.endsWith(suffix))?.content;
  const back = importBruno(files);
  const requests = byName(back.collection);

  it('writes collection.bru, folder.bru, bruno.json and protos', () => {
    expect(content('collection.bru')).toContain('headers {\n  X-Collection: yes\n}');
    expect(content('collection.bru')).toContain('auth {\n  mode: oauth2\n}');
    expect(content('collection.bru')).not.toContain('do-not-export');
    expect(content('Folder/folder.bru')).toContain('auth {\n  mode: awsv4\n}');
    const config = JSON.parse(content('bruno.json') ?? '{}') as Record<string, unknown>;
    expect(config).toMatchObject({
      scripts: { flow: 'sequential' },
      presets: { requestType: 'graphql', requestUrl: 'https://api.test' },
      protobuf: { protoFiles: [{ path: 'protos/orders/v1/orders.proto', type: 'file' }] },
    });
    expect(JSON.stringify(config)).not.toContain('proxy-pass');
    expect(JSON.stringify(config)).not.toContain('KEY');
    expect(content('protos/orders/v1/orders.proto')).toBe('syntax = "proto3";');
    // Raw sockets have no Bruno form.
    expect(files.some((file) => file.path.endsWith('socket.bru'))).toBe(false);
    const create = content('Folder/create.bru') ?? '';
    expect(create).toContain(
      'meta {\n  name: create\n  type: http\n  seq: 1\n  tags: [\n    smoke\n    orders-api\n  ]\n}',
    );
    expect(create).toContain('docs {\n  Creates\n  an order\n}');
    expect(create).toContain('~"dry run": true');
    expect(create).toContain(
      'settings {\n  encodeUrl: false\n  timeout: 5000\n  followRedirects: false\n  maxRedirects: 3\n}',
    );
    expect(content('multipart.bru')).toContain('file: @file(cat.png)');
    expect(content('multipart.bru')).toContain('meta: {"a":1} @contentType(application/json)');
    expect(content('binary.bru')).toContain(
      'file: @file(blob.bin) @contentType(application/octet-stream)',
    );
  });

  it('reads back the collection, folders and environments', () => {
    const collection = back.collection;
    expect(collection).toMatchObject({
      name: 'Parity',
      description: 'All the things',
      headers: [{ key: 'X-Collection', value: 'yes' }],
      scripts: rich.scripts,
      scriptFlow: 'sequential',
      auth: { ...rich.auth, credentialsPlacement: 'body', tokenPlacement: 'header' },
      protoFiles: rich.protoFiles,
      settings: {
        proxy: {
          enabled: true,
          protocol: 'socks5',
          hostname: 'proxy.test',
          port: 1080,
          username: 'proxy-user',
          bypass: 'localhost',
        },
        clientCertificates: [
          { domain: '*.mtls.test', type: 'pem' },
          { domain: 'pfx.test', type: 'pfx' },
        ],
        presets: { kind: 'graphql', baseUrl: 'https://api.test' },
      },
    });
    expect(collection.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.test' },
      { key: 'secretKey', value: '' },
    ]);
    const folder = collection.items[0] as ApiFolder;
    expect(folder).toMatchObject({
      type: 'folder',
      name: 'Folder',
      description: 'Folder docs',
      auth: AUTHS['awsv4'],
      headers: [{ key: 'X-Folder', value: '1' }],
      vars: [{ key: 'folderVar', value: 'f' }],
      scripts: { preRequest: 'console.log("folder");', tests: 'test("f", () => {});' },
    });
    expect(folder.items.map((item) => item.name)).toEqual(['create', 'graphql']);
    expect(back.environments).toEqual([
      {
        name: 'Prod',
        variables: [
          { key: 'baseUrl', value: 'https://prod.test' },
          { key: 'token', value: '', secret: true },
        ],
      },
    ]);
  });

  it('reads back requests with scripts, vars, checks, captures and settings', () => {
    const original = byName(rich)['create']!;
    const create = requests['create']!;
    expect(create).toMatchObject({
      method: 'POST',
      description: 'Creates\nan order',
      headers: original.headers,
      query: original.query,
      body: original.body,
      auth: original.auth,
      vars: original.vars,
      scripts: original.scripts,
      tags: ['smoke', 'orders-api'],
      settings: original.settings,
      timeoutMs: 5000,
      captures: original.captures,
    });
    const strip = (list: ApiRequestSpec['assertions']) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(create.assertions)).toEqual(
      strip(original.assertions).map((assertion) =>
        assertion.source === 'header' ? { ...assertion, path: 'content-type' } : assertion,
      ),
    );
  });

  it('keeps every request kind, auth type and body', () => {
    expect(requests['graphql']).toMatchObject({
      kind: 'graphql',
      method: 'POST',
      body: { mode: 'none' },
      graphql: {
        query: rich.items[0] && byName(rich)['graphql']!.graphql!.query,
        variables: '{\n  "first": 10\n}',
      },
    });
    expect(requests['grpc']).toMatchObject({
      kind: 'grpc',
      url: 'grpcs://grpc.test:443',
      headers: [{ key: 'x-tenant', value: 'acme' }],
      auth: { type: 'bearer', token: '{{token}}' },
      grpc: { method: 'orders.v1.Orders/Create', protoFile: 'orders/v1/orders.proto' },
    });
    expect(JSON.parse(requests['grpc']!.grpc!.message)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(requests['ws']).toMatchObject({
      kind: 'websocket',
      url: 'wss://ws.test/chat',
      websocket: { messages: [{ name: 'hello', content: '{"hi":1}', type: 'json' }] },
    });
    expect(requests['sse']).toMatchObject({ method: 'GET', url: 'https://api.test/events' });
    for (const [name, auth] of Object.entries(AUTHS)) {
      const expected = auth.type === 'oauth2' ? { ...auth, credentialsPlacement: 'basic' } : auth;
      expect(requests[`auth-${name}`]!.auth).toEqual(expected);
    }
    expect(requests['urlencoded']!.body).toEqual(byName(rich)['urlencoded']!.body);
    expect(requests['multipart']!.body).toEqual({
      mode: 'form',
      fields: [
        { key: 'meta', value: '{"a":1}', type: 'text', contentType: 'application/json' },
        { key: 'file', value: 'cat.png', type: 'text' },
      ],
    });
    expect(requests['binary']!.body).toEqual({ mode: 'binary', file: null });
    for (const name of ['xml', 'text', 'sparql']) {
      expect(requests[name]!.body).toEqual(byName(rich)[name]!.body);
    }
  });

  it('imports through importCollection as files or a single .bru file', () => {
    const imported = importCollection(JSON.stringify({ files }));
    expect(imported.format).toBe('bruno');
    expect(sourceKindOf(imported.format)).toBe('manual');
    expect(sourceKindOf('postman')).toBe('postman');
    expect(imported.environments).toHaveLength(1);
    const single = importCollection(content('xml.bru')!);
    expect(single.format).toBe('bruno');
    expect(single.collection.items[0]).toMatchObject({ name: 'xml', body: { mode: 'xml' } });
    expect(detectFormat({ files: [{ path: 'notes.txt', content: '' }] })).toBeNull();
  });
});

describe('Bruno files written by Bruno', () => {
  it('maps assertions, post-response vars, auth modes and odd syntax', () => {
    const bru = [
      'meta {',
      '  name: Odd',
      '  seq: 3',
      '}',
      '',
      'http {',
      '  method: patch',
      '  url: {{host}}/odd',
      '  body: multipartForm',
      '  auth: ntlm',
      '}',
      '',
      'query {',
      '  legacy: 1',
      '}',
      '',
      'headers {',
      '  @description(the trace id)',
      '  "X-Odd: header": a',
      "  X-Multi: '''",
      '    line 1',
      '    line 2',
      "  '''",
      '}',
      '',
      'body:multipart-form {',
      '  avatar: @file(/home/me/a.png|C:\\pics\\b.png)',
      '  ~note: hi',
      '}',
      '',
      'vars:post-response {',
      '  id: res.body.data[0].id',
      '  @local: res.headers.etag',
      "  quoted: res.headers['x-request-id']",
      '  sum: res.body.a + res.body.b',
      '  slow: res.responseTime',
      '  ~off: res.status',
      '}',
      '',
      'assert {',
      '  res.status: 200',
      '  res.body.name: startsWith "a.b"',
      '  res.body.name: endsWith z',
      '  res.body.ok: isBoolean',
      '  res.body.n: isNumber',
      '  res.body.s: isString',
      '  res.body.z: isNull',
      '  res.body.e: isEmpty',
      '  res.body.list: length 3',
      '  res.getHeader("server"): isDefined',
      '  res("data.id"): isDefined',
      '  res.body.flag: true',
      '  ~res.status: eq 500',
      '}',
      '',
      'script:post-response {',
      '  console.log(res.status);',
      '}',
      '',
      'settings {',
      '  timeout: 0',
      '}',
      '',
    ].join('\n');
    const request = requestFromBru(bru, 'fallback');
    expect(request).toMatchObject({
      name: 'Odd',
      method: 'PATCH',
      url: '{{host}}/odd',
      auth: { type: 'none' },
      query: [{ key: 'legacy', value: '1' }],
      headers: [
        { key: 'X-Odd: header', value: 'a' },
        { key: 'X-Multi', value: 'line 1\nline 2' },
      ],
      body: {
        mode: 'form',
        fields: [
          { key: 'avatar', value: 'a.png, b.png', type: 'text' },
          { key: 'note', value: 'hi', type: 'text', enabled: false },
        ],
      },
      captures: [
        { variable: 'id', source: 'json', path: 'data[0].id' },
        { variable: 'local', source: 'header', path: 'etag' },
        { variable: 'quoted', source: 'header', path: 'x-request-id' },
      ],
      scripts: {
        postResponse:
          'console.log(res.status);\nadk.setVar("sum", res.body.a + res.body.b);\nadk.setVar("slow", res.responseTime);',
      },
    });
    expect(request.timeoutMs).toBeUndefined();
    expect(
      request.assertions.map(({ source, path, operator, expected }) => [
        source,
        path,
        operator,
        expected,
      ]),
    ).toEqual([
      ['status', undefined, 'eq', '200'],
      ['json', 'name', 'matches', '^a\\.b'],
      ['json', 'name', 'matches', 'z$'],
      ['json', 'ok', 'isType', 'boolean'],
      ['json', 'n', 'isType', 'number'],
      ['json', 's', 'isType', 'string'],
      ['json', 'z', 'isType', 'null'],
      ['header', 'server', 'exists', undefined],
      ['json', 'flag', 'eq', 'true'],
    ]);
  });

  it('maps OAuth2 grants, OAuth1 methods, EdgeGrid and the older bruno.json proxy', () => {
    const withAuth = (mode: string, lines: string[]) =>
      requestFromBru(
        [
          'get {',
          '  url: x',
          `  auth: ${mode}`,
          '}',
          '',
          `auth:${mode} {`,
          ...lines.map((l) => `  ${l}`),
          '}',
        ].join('\n'),
        'r',
      ).auth;
    expect(withAuth('oauth2', ['grant_type: authorization_code'])).toEqual({ type: 'none' });
    expect(
      withAuth('oauth2', [
        'grant_type: client_credentials',
        'access_token_url: https://t',
        'client_id: id',
        'client_secret: s',
        'credentials_placement: basic_auth_header',
        'token_placement: header',
        'token_header_prefix: ',
      ]),
    ).toEqual({
      type: 'oauth2',
      grantType: 'client_credentials',
      accessTokenUrl: 'https://t',
      clientId: 'id',
      clientSecret: 's',
      credentialsPlacement: 'basic',
      tokenPlacement: 'header',
    });
    expect(
      withAuth('oauth1', ['consumer_key: k', 'consumer_secret: s', 'signature_method: RSA-SHA1']),
    ).toEqual({
      type: 'oauth1',
      consumerKey: 'k',
      consumerSecret: 's',
      signatureMethod: 'HMAC-SHA1',
      addTo: 'header',
    });
    expect(
      withAuth('akamai-edgegrid', [
        'accessToken: a',
        'clientToken: c',
        'clientSecret: s',
        'maxBodySize: ',
      ]),
    ).toEqual({ type: 'edgegrid', accessToken: 'a', clientToken: 'c', clientSecret: 's' });
    expect(
      withAuth('awsv4', ['accessKeyId: a', 'secretAccessKey: s', 'service: s3', 'region: r']),
    ).toEqual({
      type: 'awsv4',
      accessKeyId: 'a',
      secretAccessKey: 's',
      service: 's3',
      region: 'r',
    });

    const imported = importBruno([
      {
        path: 'col/bruno.json',
        content: JSON.stringify({
          name: 'Old',
          proxy: {
            enabled: false,
            protocol: 'ftp',
            hostname: 'p',
            port: 3128,
            auth: { enabled: false, username: 'x' },
          },
          presets: { requestType: 'unknown' },
        }),
      },
      { path: 'col/a/b/deep.bru', content: 'get {\n  url: x\n}\n' },
      { path: 'col/z.bru', content: 'meta {\n  name: Z\n  seq: 1\n}\n\nget {\n  url: z\n}\n' },
      { path: 'elsewhere/ignored.bru', content: 'get {\n  url: y\n}\n' },
    ]);
    expect(imported.collection).toMatchObject({
      name: 'Old',
      auth: { type: 'none' },
      settings: {
        proxy: { enabled: false, protocol: 'http', hostname: 'p', port: 3128 },
        presets: {},
      },
    });
    expect(imported.collection.settings?.proxy?.username).toBeUndefined();
    expect(imported.collection.items.map((item) => item.name)).toEqual(['Z', 'a']);
    expect(flattenRequests(imported.collection).map((flat) => flat.path)).toEqual([[], ['a', 'b']]);

    const broken = importBruno([
      { path: 'bruno.json', content: '{oops' },
      { path: 'r.bru', content: 'get {\n  url: x\n}\n' },
    ]);
    expect(broken.collection.name).toBe('Bruno collection');
    expect(parseBru('vars:secret [\n  a,\n  b\n]\n')).toEqual([
      { name: 'vars:secret', items: ['a', 'b'] },
    ]);
  });
});

describe('Postman parity', () => {
  const postman = exportPostman(rich);
  const back = importCollection(JSON.stringify(postman)).collection;
  const requests = byName(back);

  it('writes events, graphql, auth types and protocol behaviour', () => {
    const text = JSON.stringify(postman);
    expect(text).not.toContain('do-not-export');
    expect(postman['event']).toEqual([
      {
        listen: 'prerequest',
        // Exports rename adk to Postman's pm; the calls keep their names.
        script: { type: 'text/javascript', exec: ['pm.setVar("started", Date.now());'] },
      },
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            'console.log("done");',
            'test("collection", () => expect(res.status).to.be.below(500));',
          ],
        },
      },
    ]);
    // gRPC, WebSocket and socket requests are left out.
    expect(Object.keys(requests)).not.toContain('grpc');
    expect(Object.keys(requests)).not.toContain('ws');
    expect(Object.keys(requests)).not.toContain('socket');
  });

  it('reads back scripts, checks, auth, bodies and settings', () => {
    const original = byName(rich);
    expect(back.scripts).toEqual({
      preRequest: rich.scripts!.preRequest,
      postResponse: `${rich.scripts!.postResponse}\n${rich.scripts!.tests}`,
    });
    const folder = back.items[0] as ApiFolder;
    expect(folder).toMatchObject({
      auth: AUTHS['awsv4'],
      vars: [{ key: 'folderVar', value: 'f' }],
      description: 'Folder docs',
      scripts: { preRequest: 'console.log("folder");', postResponse: 'test("f", () => {});' },
    });
    expect(requests['create']).toMatchObject({
      vars: [{ key: 'reqVar', value: 'r' }],
      settings: { encodeUrl: false, followRedirects: false, maxRedirects: 3 },
      scripts: {
        preRequest: original['create']!.scripts!.preRequest,
        postResponse: `${original['create']!.scripts!.postResponse}\n${original['create']!.scripts!.tests}`,
      },
      captures: [{ variable: 'orderId', source: 'json', path: 'data.id' }],
    });
    expect(requests['graphql']).toMatchObject({
      kind: 'graphql',
      graphql: { query: original['graphql']!.graphql!.query, variables: '{\n  "first": 10\n}' },
    });
    for (const name of ['basic', 'apikey', 'digest', 'awsv4', 'edgegrid', 'none']) {
      expect(requests[`auth-${name}`]!.auth).toEqual(AUTHS[name]);
    }
    expect(requests['auth-wsse']!.auth).toEqual({ type: 'none' });
    expect(requests['auth-oauth1']!.auth).toEqual(AUTHS['oauth1']);
    expect(requests['auth-oauth2']!.auth).toEqual({
      ...AUTHS['oauth2'],
      tokenQueryKey: undefined,
    } as unknown as RequestAuth);
    expect(back.auth).toEqual({
      ...rich.auth,
      credentialsPlacement: 'body',
      tokenPlacement: 'header',
    });
    expect(requests['multipart']!.body).toEqual({
      mode: 'form',
      fields: [
        { key: 'meta', value: '{"a":1}', type: 'text', contentType: 'application/json' },
        { key: 'file', value: 'cat.png', type: 'text' },
      ],
    });
    expect(requests['binary']!.body).toEqual({ mode: 'binary', file: null });
    expect(requests['sparql']!.body).toEqual({ mode: 'text', content: 'SELECT * WHERE {}' });
  });

  it('keeps foreign test scripts as post-response scripts and maps other auth types', () => {
    const imported = importCollection(
      JSON.stringify({
        info: {
          name: 'Foreign',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            name: 'r',
            event: [
              {
                listen: 'test',
                script: { exec: 'pm.test("s", () => pm.response.to.have.status(200));' },
              },
            ],
            request: {
              method: 'GET',
              url: 'https://x.test',
              auth: {
                type: 'oauth2',
                oauth2: [{ key: 'grant_type', value: 'authorization_code' }],
              },
              body: {
                mode: 'formdata',
                formdata: [{ key: 'f', type: 'file', src: ['/a/one.txt', 'C:\\b\\two.txt'] }],
              },
            },
          },
          { name: 'n', request: { url: 'https://x.test', auth: { type: 'ntlm' } } },
          { name: 'h', request: { url: 'https://x.test', auth: { type: 'hawk' } } },
          {
            name: 'o',
            request: {
              url: 'https://x.test',
              auth: {
                type: 'oauth1',
                oauth1: [
                  { key: 'signatureMethod', value: 'RSA-SHA1' },
                  { key: 'addParamsToHeader', value: false },
                ],
              },
            },
          },
          {
            name: 'g',
            request: {
              method: 'POST',
              url: 'https://x.test/graphql',
              body: { mode: 'graphql', graphql: { query: '{ a }', variables: { b: 1 } } },
            },
          },
        ],
      }),
    ).collection;
    const [r, n, h, o, g] = flattenRequests(imported).map((flat) => flat.request);
    expect(r).toMatchObject({
      assertions: [],
      scripts: { postResponse: 'adk.test("s", () => adk.response.to.have.status(200));' },
      auth: { type: 'none' },
      body: { mode: 'form', fields: [{ key: 'f', value: 'one.txt, two.txt', type: 'text' }] },
    });
    expect(n!.auth).toEqual({ type: 'none' });
    expect(h!.auth).toEqual({ type: 'inherit' });
    expect(o!.auth).toMatchObject({ type: 'oauth1', signatureMethod: 'HMAC-SHA1', addTo: 'query' });
    expect(g!.graphql).toEqual({ query: '{ a }', variables: '{\n  "b": 1\n}' });
  });
});

describe('Insomnia parity', () => {
  const exported = exportInsomnia(rich);
  const back = importCollection(JSON.stringify(exported)).collection;
  const requests = byName(back);

  it('round-trips graphql, auth types, scripts and settings', () => {
    expect(requests['graphql']).toMatchObject({
      kind: 'graphql',
      graphql: {
        query: byName(rich)['graphql']!.graphql!.query,
        variables: '{\n  "first": 10\n}',
        operationName: 'Orders',
      },
    });
    for (const name of ['basic', 'apikey', 'digest', 'awsv4', 'none']) {
      expect(requests[`auth-${name}`]!.auth).toEqual(AUTHS[name]);
    }
    expect(requests['auth-oauth1']!.auth).toEqual({
      type: 'oauth1',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 'tk',
      tokenSecret: 'ts',
      signatureMethod: 'HMAC-SHA256',
      realm: 'photos',
    });
    expect(requests['auth-oauth2']!.auth).toMatchObject({
      type: 'oauth2',
      grantType: 'password',
      username: 'ou',
      credentialsPlacement: 'basic',
    });
    expect(requests['auth-wsse']!.auth).toEqual({ type: 'none' });
    expect(requests['create']).toMatchObject({
      scripts: {
        preRequest: byName(rich)['create']!.scripts!.preRequest,
        postResponse:
          'adk.setVar("x", res.body.x);\ntest("ok", () => expect(res.status).to.equal(201));',
      },
      settings: { followRedirects: false, encodeUrl: false },
    });
    expect(requests['create']!.description).toContain(INSOMNIA_SCRIPT_NOTE);
    expect((back.items[0] as ApiFolder).vars).toEqual([{ key: 'folderVar', value: 'f' }]);
    expect(requests['multipart']!.body).toMatchObject({
      fields: [{ key: 'meta' }, { key: 'file', value: 'cat.png' }],
    });
    expect(requests['binary']!.body).toEqual({ mode: 'binary', file: null });
    expect(Object.keys(requests)).not.toContain('grpc');
  });

  it('imports Insomnia-only auth and odd graphql bodies', () => {
    const resource = (name: string, extra: Record<string, unknown>) => ({
      _id: `req_${name}`,
      _type: 'request',
      parentId: 'wrk',
      name,
      method: 'POST',
      url: 'https://x.test',
      ...extra,
    });
    const imported = importCollection(
      JSON.stringify({
        _type: 'export',
        __export_format: 4,
        resources: [
          { _id: 'wrk', _type: 'workspace', name: 'I' },
          resource('hawk', { authentication: { type: 'hawk' } }),
          resource('code', { authentication: { type: 'oauth2', grantType: 'authorization_code' } }),
          resource('refresh', {
            authentication: {
              type: 'oauth2',
              grantType: 'refresh_token',
              refreshToken: 'rt',
              credentialsInBody: true,
              audience: 'aud',
            },
          }),
          resource('raw', { body: { mimeType: 'application/graphql', text: '{ notJson' } }),
          resource('follow', { settingFollowRedirects: 'global' }),
        ],
      }),
    ).collection;
    const requests = byName(imported);
    expect(requests['hawk']!.auth).toEqual({ type: 'none' });
    expect(requests['code']!.auth).toEqual({ type: 'none' });
    expect(requests['refresh']!.auth).toMatchObject({
      grantType: 'refresh_token',
      refreshToken: 'rt',
      credentialsPlacement: 'body',
      audience: 'aud',
    });
    expect(requests['raw']!.graphql).toEqual({ query: '{ notJson' });
    expect(requests['follow']!.settings).toBeUndefined();
  });
});

describe('k6 parity', () => {
  it('skips non-HTTP kinds, posts graphql as JSON and marks unexported auth', () => {
    const ids = ['graphql', 'grpc', 'auth-digest', 'binary', 'sparql', 'auth-none'];
    const script = exportK6(rich, {
      name: 'Parity',
      requests: ids.map((requestId) => ({ requestId, weight: 1 })),
      stages: [{ durationSec: 5, targetVus: 1 }],
      thinkTimeMs: 0,
      thresholds: [],
    });
    expect(script).toContain('// grpc: grpc requests are not exported to k6');
    expect(script).toContain('// TODO: digest auth is not exported to k6');
    expect(script).toContain('http.request("POST", url, v("{\\"query\\":');
    expect(script).toContain('\\"variables\\":{\\"first\\":10},\\"operationName\\":\\"Orders\\"');
    expect(script).toContain('headers[\'Content-Type\'] = "application/sparql-query"');
    const file = join(mkdtempSync(join(tmpdir(), 'k6-')), 'script.mjs');
    writeFileSync(file, script);
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
  });
});

describe('ADK format', () => {
  it('keeps every new field', () => {
    const back = importCollection(JSON.stringify(exportAdk(rich))).collection;
    expect(back).toEqual({
      ...rich,
      variables: [rich.variables[0], { ...rich.variables[1], value: '' }],
    });
  });
});
