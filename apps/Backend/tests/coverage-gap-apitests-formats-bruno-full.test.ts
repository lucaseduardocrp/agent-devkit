import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import type { ApiRequestSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';
import {
  environmentFromBru,
  exportBruno,
  importBruno,
  parseBru,
  requestFile,
  requestFromBru,
} from '../src/modules/apitests/formats/bruno.js';

const request = (overrides: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id: 'r',
  type: 'request',
  name: 'Req',
  method: 'GET',
  url: 'https://api.test/x',
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

/** Every auth, first with each optional field filled in, then with none of them. */
const FILLED: RequestAuth[] = [
  { type: 'bearer', token: 'tok' },
  { type: 'digest', username: 'u', password: 'p' },
  { type: 'wsse', username: 'u', password: 'p' },
  {
    type: 'awsv4',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    sessionToken: 'ST',
    service: 's3',
    region: 'us-east-1',
  },
  {
    type: 'oauth2',
    grantType: 'password',
    accessTokenUrl: 'https://id.test/token',
    clientId: 'id',
    clientSecret: 'secret',
    username: 'u',
    password: 'p',
    scope: 'read',
    credentialsPlacement: 'basic',
    tokenPlacement: 'query',
    tokenQueryKey: 'at',
  },
  {
    type: 'oauth1',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    token: 't',
    tokenSecret: 'ts',
    signatureMethod: 'HMAC-SHA1',
    realm: 'r',
    addTo: 'query',
  },
  {
    type: 'edgegrid',
    accessToken: 'at',
    clientToken: 'ct',
    clientSecret: 'cs',
    headersToSign: 'x-a',
    maxBodySize: 2048,
  },
];

const BARE: RequestAuth[] = [
  {
    type: 'awsv4',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    service: 's3',
    region: 'us-east-1',
  },
  {
    type: 'oauth2',
    grantType: 'refresh_token',
    accessTokenUrl: 'https://id.test/token',
    clientId: 'id',
    clientSecret: 'secret',
  },
  {
    type: 'oauth1',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    signatureMethod: 'HMAC-SHA256',
  },
  { type: 'edgegrid', accessToken: 'at', clientToken: 'ct', clientSecret: 'cs' },
];

describe('exportBruno writes every auth, kind and setting', () => {
  const collection = (items: CollectionInput['items'], extra: Partial<CollectionInput> = {}) =>
    ({
      name: 'All',
      variables: [],
      auth: { type: 'none' },
      items,
      ...extra,
    }) satisfies CollectionInput;

  it('writes each auth with its optional fields and then without them', () => {
    const files = exportBruno(
      collection([...FILLED, ...BARE].map((auth, index) => request({ name: `a${index}`, auth }))),
    );
    const content = files.map((file) => file.content).join('\n');
    for (const line of [
      'token: tok',
      'sessionToken: ST',
      'grant_type: password',
      'username: u',
      'credentials_placement: basic_auth_header',
      'token_placement: url',
      'token_query_key: at',
      'signature_method: HMAC-SHA1',
      'realm: r',
      'placement: query',
      'headersToSign: x-a',
      'maxBodySize: 2048',
      'auth: akamai-edgegrid',
    ]) {
      expect(content).toContain(line);
    }
    // The bare variants keep the same keys with empty values.
    expect(content).toContain('sessionToken: \n');
    expect(content).toContain('grant_type: client_credentials');
    expect(content).toContain('credentials_placement: body');
    expect(content).toContain('token_header_prefix: Bearer');
    expect(content).toContain('realm: \n');
  });

  it('writes a grpc request with its proto file and one message per array entry', () => {
    const files = exportBruno(
      collection([
        {
          ...request({ name: 'Grpc', tags: ['smoke', 'a b'] }),
          kind: 'grpc',
          headers: [{ key: 'x-m', value: '1' }],
          grpc: {
            method: '/demo.v1.Greeter/Say',
            message: '[{"id":"a"},{"id":"b"}]',
            protoFile: 'demo.proto',
          },
        },
      ]),
    );
    const content = fileOf(files, 'All/Grpc.bru');
    expect(content).toContain('type: grpc');
    expect(content).toContain('tags: [\n    smoke\n    a-b\n  ]');
    expect(content).toContain('method: /demo.v1.Greeter/Say');
    expect(content).toContain('protoPath: protos/demo.proto');
    expect(content).toContain('name: message 1');
    expect(content).toContain('name: message 2');
  });

  it('writes a grpc request with no spec and a message that is not JSON', () => {
    const files = exportBruno(
      collection([
        { ...request({ name: 'Bare' }), kind: 'grpc' },
        {
          ...request({ name: 'Text' }),
          kind: 'grpc',
          grpc: { method: 'M', message: 'not json' },
        },
        {
          ...request({ name: 'Object' }),
          kind: 'grpc',
          grpc: { method: 'M', message: '{"id":1}' },
        },
      ]),
    );
    expect(fileOf(files, 'All/Bare.bru')).toContain('method: \n');
    expect(fileOf(files, 'All/Text.bru')).toContain('not json');
    expect(fileOf(files, 'All/Object.bru')).toContain('{"id":1}');
  });

  it('writes a websocket request with named and typed messages, and skips a socket one', () => {
    const files = exportBruno(
      collection([
        {
          ...request({ name: 'Ws' }),
          kind: 'websocket',
          websocket: {
            messages: [{ name: 'first', content: 'a', type: 'json' }, { content: 'b' }],
          },
        },
        { ...request({ name: 'Bare ws' }), kind: 'websocket' },
        { ...request({ name: 'Socket' }), kind: 'socket' },
      ]),
    );
    const ws = fileOf(files, 'All/Ws.bru');
    expect(ws).toContain('name: first');
    expect(ws).toContain('type: json');
    expect(ws).toContain('name: message 2');
    expect(fileOf(files, 'All/Bare ws.bru')).toContain('body: ws');
    expect(files.some((file) => file.path === 'All/Socket.bru')).toBe(false);
  });

  it('writes bodies that carry content types, files and quoted keys', () => {
    const files = exportBruno(
      collection([
        request({
          name: 'Bodies',
          method: 'POST',
          body: {
            mode: 'form',
            fields: [
              { key: 'a:b', value: 'line one\nline two', contentType: 'text/plain' },
              { key: 'f', value: 'fallback', type: 'file' },
              {
                key: 'g',
                value: '',
                type: 'file',
                file: { fileName: 'g.bin', contentType: '', data: '' },
              },
            ],
          },
        }),
        request({
          name: 'Binary',
          method: 'POST',
          body: { mode: 'binary', file: { fileName: 'a.bin', contentType: 'image/png', data: '' } },
        }),
        request({
          name: 'Binary bare',
          method: 'POST',
          body: { mode: 'binary', file: { fileName: 'b.bin', contentType: '', data: '' } },
        }),
        request({ name: 'Binary none', method: 'POST', body: { mode: 'binary', file: null } }),
      ]),
    );
    const bodies = fileOf(files, 'All/Bodies.bru');
    expect(bodies).toContain("\"a:b\": '''");
    expect(bodies).toContain('@contentType(text/plain)');
    expect(bodies).toContain('f: @file(fallback)');
    expect(bodies).toContain('g: @file(g.bin)');
    expect(fileOf(files, 'All/Binary.bru')).toContain('@file(a.bin) @contentType(image/png)');
    expect(fileOf(files, 'All/Binary bare.bru')).toContain('file: @file(b.bin)\n');
    expect(fileOf(files, 'All/Binary none.bru')).not.toContain('body:file');
  });

  it('writes a json assertion whose path starts with an index', () => {
    const files = exportBruno(
      collection([
        request({
          name: 'Indexed',
          assertions: [{ id: '1', source: 'json', path: '[0].id', operator: 'eq', expected: '1' }],
        }),
      ]),
    );
    expect(fileOf(files, 'All/Indexed.bru')).toContain('res.body[0].id: eq 1');
  });

  it('writes the proxy, certificates, presets and proto files of the collection config', () => {
    const files = exportBruno(
      collection([request({ name: 'R' })], {
        protoFiles: [{ name: 'demo.proto', content: 'syntax = "proto3";' }],
        settings: {
          proxy: {
            enabled: true,
            protocol: 'http',
            hostname: 'proxy.test',
            port: 8080,
            username: 'u',
            bypass: 'localhost',
          },
          clientCertificates: [
            { domain: 'a.test', type: 'pfx', pfx: '', passphrase: '' },
            { domain: 'b.test', type: 'pem', cert: '', key: '' },
          ],
          presets: { kind: 'graphql', baseUrl: 'https://api.test' },
        },
      }),
    );
    const config = JSON.parse(fileOf(files, 'All/bruno.json')) as Record<string, unknown>;
    expect(config['proxy']).toMatchObject({ inherit: false });
    expect(config['clientCertificates']).toMatchObject({ enabled: true });
    expect(config['presets']).toEqual({ requestType: 'graphql', requestUrl: 'https://api.test' });
    expect(config['protobuf']).toMatchObject({ importPaths: [{ path: 'protos', enabled: true }] });
    expect(fileOf(files, 'All/protos/demo.proto')).toBe('syntax = "proto3";');
  });

  it('disables the proxy and the certificate passphrase when the settings leave them out', () => {
    const files = exportBruno(
      collection([request({ name: 'R' })], {
        settings: {
          proxy: { enabled: false, protocol: 'http', hostname: 'proxy.test', port: 8080 },
          presets: {},
        },
      }),
    );
    const config = JSON.parse(fileOf(files, 'All/bruno.json')) as Record<string, unknown>;
    expect(config['proxy']).toMatchObject({ disabled: true });
    expect(config['presets']).toEqual({ requestType: 'http', requestUrl: '' });
  });

  it('returns null for a socket request file', () => {
    expect(requestFile({ ...request(), kind: 'socket' }, 1)).toBeNull();
  });
});

describe('parseBru reads the shapes Bruno writes', () => {
  it('reads lists, quoted keys, multi-line values and annotations', () => {
    const blocks = parseBru(
      [
        'meta {',
        '  name: R',
        '  tags: [',
        '    smoke, slow',
        '    flaky',
        '  ]',
        '}',
        'headers {',
        '  @description(ignored)',
        '  "x:a": 1',
        '  ~off: 2',
        '  broken',
        '  "unclosed: 3',
        "  multi: '''",
        '    one',
        '    two',
        "  ''' @contentType(text/plain)",
        '  typed: value @contentType(application/json)',
        '}',
        'docs {',
        '',
        '  the docs',
        '}',
        'not a block',
      ].join('\r\n'),
    );
    const headers = blocks.find((block) => block.name === 'headers')?.pairs ?? [];
    // A list inside a pair keeps each line as written; only a  block splits on commas.
    expect(blocks.find((block) => block.name === 'meta')?.pairs?.[1]?.list).toEqual([
      'smoke, slow',
      'flaky',
    ]);
    expect(headers.map((pair) => pair.key)).toEqual(['x:a', 'off', 'multi', 'typed']);
    expect(headers[1]?.enabled).toBe(false);
    expect(headers[2]?.value).toBe('one\ntwo');
    expect(headers[2]?.contentType).toBe('text/plain');
    expect(headers[3]?.value).toBe('value');
    expect(blocks.find((block) => block.name === 'docs')?.text).toBe('the docs');
  });

  it('reads an empty list and a value block that never closes', () => {
    const blocks = parseBru(['vars:secret [', ']', 'body:json {', '  {"a":1}'].join('\n'));
    expect(blocks[0]?.items).toEqual([]);
    expect(blocks[1]?.text).toBe('{"a":1}');
  });
});

describe('requestFromBru reads every kind', () => {
  it('reads an http request with an explicit method block and settings', () => {
    const spec = requestFromBru(
      [
        'meta {',
        '  name: ',
        '}',
        'http {',
        '  url: https://api.test/a',
        '  method: PATCH',
        '  body: json',
        '  auth: bearer',
        '}',
        'auth:bearer {',
        '  token: tok',
        '}',
        'body:json {',
        '  {"a":1}',
        '}',
        'params:path {',
        '  id: 1',
        '}',
        'vars:pre-request {',
        '  v: 1',
        '}',
        'settings {',
        '  encodeUrl: true',
        '}',
        'assert {',
        '  res.status: eq 200',
        '  ~res.body: eq skipped',
        '}',
      ].join('\n'),
      'Fallback',
    );
    expect(spec.name).toBe('Fallback');
    expect(spec.method).toBe('PATCH');
    expect(spec.auth).toEqual({ type: 'bearer', token: 'tok' });
    expect(spec.pathParams).toEqual([{ key: 'id', value: '1' }]);
    expect(spec.vars).toEqual([{ key: 'v', value: '1' }]);
    expect(spec.assertions.length).toBe(1);
  });

  it('falls back to GET for a method Bruno does not name', () => {
    const spec = requestFromBru('http {\n  url: https://api.test/\n  method: TRACE\n}', 'R');
    expect(spec.method).toBe('GET');
  });

  it('reads a grpc request without a proto path and with one message', () => {
    const spec = requestFromBru(
      [
        'meta {',
        '  type: grpc',
        '}',
        'grpc {',
        '  url: grpc://api.test',
        '  method: /demo.v1.Greeter/Say',
        '}',
        'body:grpc {',
        '  name: first',
        "  content: '''",
        '    {"id":"a"}',
        "  '''",
        '}',
      ].join('\n'),
      'R',
    );
    expect(spec.grpc).toEqual({ method: 'demo.v1.Greeter/Say', message: '{"id":"a"}' });
    expect(spec.auth).toEqual({ type: 'inherit' });
  });

  it('reads a grpc request with no messages at all', () => {
    const spec = requestFromBru('grpc {\n  url: grpc://api.test\n  method: M\n}', 'R');
    expect(spec.grpc?.message).toBe('{}');
  });

  it('reads a websocket request with a typed message', () => {
    const spec = requestFromBru(
      [
        'ws {',
        '  url: ws://api.test',
        '  auth: none',
        '}',
        'body:ws {',
        '  type: binary',
        '  content: aGk=',
        '}',
        'body:ws {',
        '  type: nonsense',
        '  content: plain',
        '}',
      ].join('\n'),
      'R',
    );
    expect(spec.websocket?.messages[0]).toEqual({ type: 'binary', content: 'aGk=' });
    expect(spec.websocket?.messages[1]).toEqual({ content: 'plain' });
  });

  it('reads multipart fields with file paths, content types and disabled rows', () => {
    const spec = requestFromBru(
      [
        'post {',
        '  url: https://api.test/',
        '  body: multipartForm',
        '}',
        'body:multipart-form {',
        '  a: @file(C:\\tmp\\one.txt|/var/two.txt)',
        '  b: plain @contentType(text/plain)',
        '  ~c: off',
        '}',
      ].join('\n'),
      'R',
    );
    const fields = spec.body.mode === 'form' ? spec.body.fields : [];
    expect(fields[0]?.value).toBe('one.txt, two.txt');
    expect(fields[1]?.contentType).toBe('text/plain');
    expect(fields[2]?.enabled).toBe(false);
  });

  it('reads a binary body and an unknown mode', () => {
    expect(requestFromBru('post {\n  url: https://api.test/\n  body: file\n}', 'R').body).toEqual({
      mode: 'binary',
      file: null,
    });
    expect(
      requestFromBru('post {\n  url: https://api.test/\n  body: nonsense\n}', 'R').body,
    ).toEqual({ mode: 'none' });
  });

  it('reads a graphql request with and without variables', () => {
    const withVariables = requestFromBru(
      [
        'post {',
        '  url: https://api.test/',
        '  body: graphql',
        '}',
        'body:graphql {',
        '  { a }',
        '}',
        'body:graphql:vars {',
        '  {"id":1}',
        '}',
      ].join('\n'),
      'R',
    );
    expect(withVariables.graphql).toEqual({ query: '{ a }', variables: '{"id":1}' });
    const bare = requestFromBru('post {\n  url: https://api.test/\n  body: graphql\n}', 'R');
    expect(bare.graphql).toEqual({ query: '' });
  });

  it('reads every auth block back, with and without its optional fields', () => {
    const auth = (mode: string, lines: readonly string[]) =>
      requestFromBru(
        [
          'get {',
          '  url: https://api.test/',
          `  auth: ${mode}`,
          '}',
          `auth:${mode} {`,
          ...lines.map((line) => `  ${line}`),
          '}',
        ].join('\n'),
        'R',
      ).auth;

    expect(auth('awsv4', ['accessKeyId: AK', 'sessionToken: ST'])).toMatchObject({
      sessionToken: 'ST',
    });
    expect(auth('awsv4', ['accessKeyId: AK'])).not.toHaveProperty('sessionToken');
    expect(
      auth('oauth2', [
        'grant_type: password',
        'username: u',
        'password: p',
        'scope: read',
        'credentials_placement: basic_auth_header',
        'token_placement: url',
        'token_query_key: at',
      ]),
    ).toMatchObject({
      grantType: 'password',
      username: 'u',
      scope: 'read',
      credentialsPlacement: 'basic',
      tokenPlacement: 'query',
      tokenQueryKey: 'at',
    });
    expect(
      auth('oauth2', ['grant_type: client_credentials', 'token_placement: url']),
    ).toMatchObject({ tokenQueryKey: 'access_token' });
    expect(
      auth('oauth2', ['grant_type: client_credentials', 'token_header_prefix: Token']),
    ).toMatchObject({ tokenPrefix: 'Token' });
    expect(auth('oauth2', ['grant_type: client_credentials'])).not.toHaveProperty('tokenPrefix');
    expect(
      auth('oauth1', ['signature_method: HMAC-SHA512', 'realm: r', 'placement: query']),
    ).toMatchObject({ realm: 'r', addTo: 'query' });
    expect(auth('akamai-edgegrid', ['headersToSign: x-a', 'maxBodySize: 10'])).toMatchObject({
      headersToSign: 'x-a',
      maxBodySize: 10,
    });
    expect(auth('akamai-edgegrid', [])).not.toHaveProperty('headersToSign');
    expect(auth('nonsense', [])).toEqual({ type: 'none' });
  });
});

describe('environmentFromBru and importBruno', () => {
  it('reads secret variables out of a vars:secret list', () => {
    const environment = environmentFromBru(
      'Local',
      ['vars {', '  a: 1', '}', 'vars:secret [', '  ~token', ']'].join('\n'),
    );
    expect(environment.variables).toEqual([
      { key: 'a', value: '1' },
      { key: 'token', value: '', secret: true },
    ]);
  });

  it('reads an environment with no secret list at all', () => {
    expect(environmentFromBru('Local', 'vars {\n  a: 1\n}').variables).toEqual([
      { key: 'a', value: '1' },
    ]);
  });

  it('round-trips a collection through export and import', () => {
    const original = {
      name: 'Round',
      description: 'docs',
      variables: [{ key: 'base', value: 'https://api.test' }],
      auth: { type: 'bearer', token: 'tok' },
      headers: [{ key: 'x-a', value: '1' }],
      scriptFlow: 'sandwich',
      protoFiles: [{ name: 'demo.proto', content: 'syntax = "proto3";' }],
      items: [
        {
          id: 'f',
          type: 'folder',
          name: 'Folder',
          items: [
            request({ name: 'Inner', method: 'POST', body: { mode: 'json', content: '{}' } }),
          ],
        },
        {
          ...request({ name: 'Grpc' }),
          kind: 'grpc',
          grpc: { method: 'demo.v1.Greeter/Say', message: '{}', protoFile: 'demo.proto' },
        },
      ],
    } satisfies CollectionInput;
    const files = exportBruno(original, [
      { name: 'Local', variables: [{ key: 'base', value: 'https://local.test' }] },
    ]);
    const { collection, environments } = importBruno(files);
    expect(collection.name).toBe('Round');
    expect(collection.auth).toEqual({ type: 'bearer', token: 'tok' });
    expect(collection.scriptFlow).toBe('sandwich');
    expect(collection.protoFiles).toEqual([{ name: 'demo.proto', content: 'syntax = "proto3";' }]);
    expect(environments[0]?.name).toBe('Local');
    const folder = collection.items.find((item) => item.type === 'folder');
    expect(folder?.name).toBe('Folder');
  });

  it('names a collection that carries no name of its own', () => {
    const { collection } = importBruno([
      { path: 'collection.bru', content: 'auth {\n  mode: none\n}' },
    ]);
    expect(collection.name).toBe('Bruno collection');
    expect(collection.auth).toEqual({ type: 'none' });
  });

  it('ignores a bruno.json that is not valid JSON', () => {
    const { collection } = importBruno([
      { path: './root/bruno.json', content: '{not json' },
      { path: 'root/R.bru', content: 'get {\n  url: https://api.test/\n}' },
    ]);
    expect(collection.items.length).toBe(1);
  });
});

describe('the remaining defaults of both directions', () => {
  it('writes an oauth2 password grant and a query token with no values set', () => {
    const files = exportBruno({
      name: 'Defaults',
      variables: [],
      auth: { type: 'none' },
      items: [
        request({
          name: 'R',
          auth: {
            type: 'oauth2',
            grantType: 'password',
            accessTokenUrl: 'https://id.test/token',
            clientId: 'id',
            clientSecret: 'secret',
            tokenPlacement: 'query',
          },
        }),
      ],
    });
    const content = fileOf(files, 'Defaults/R.bru');
    expect(content).toContain('username: \n');
    expect(content).toContain('password: \n');
    expect(content).toContain('token_query_key: access_token');
  });

  it('writes a disabled multipart field and a graphql request with an empty query', () => {
    const files = exportBruno({
      name: 'Edges',
      variables: [],
      auth: { type: 'none' },
      items: [
        request({
          name: 'Form',
          method: 'POST',
          body: { mode: 'form', fields: [{ key: 'a', value: '1', enabled: false }] },
        }),
        { ...request({ name: 'Gql' }), kind: 'graphql', graphql: { query: '' } },
      ],
    });
    expect(fileOf(files, 'Edges/Form.bru')).toContain('~a: 1');
    // An empty query becomes a blank text block, which writes nothing.
    expect(fileOf(files, 'Edges/Gql.bru')).toContain('body: graphql');
    expect(fileOf(files, 'Edges/Gql.bru')).not.toContain('body:graphql {');
  });

  it('writes a preset kind that Bruno does not know as http', () => {
    const files = exportBruno({
      name: 'Preset',
      variables: [],
      auth: { type: 'none' },
      items: [request({ name: 'R' })],
      settings: { presets: { kind: 'socket', baseUrl: '' } },
    });
    const config = JSON.parse(fileOf(files, 'Preset/bruno.json')) as Record<string, unknown>;
    expect(config['presets']).toEqual({ requestType: 'http', requestUrl: '' });
  });

  it('reads a multi-line value that runs to the end of the file', () => {
    const blocks = parseBru(['headers {', "  content: '''", '    {"a":1}'].join('\n'));
    expect(blocks[0]?.pairs?.[0]?.value).toBe('{"a":1}');
    expect(blocks[0]?.pairs?.[0]?.contentType).toBeUndefined();
  });

  it('skips a blank line inside a list value', () => {
    const blocks = parseBru(['meta {', '  tags: [', '', '    smoke', '  ]', '}'].join('\n'));
    expect(blocks[0]?.pairs?.[0]?.list).toEqual(['smoke']);
  });

  it('reads a bearer block with no token and an apikey placed in the header', () => {
    expect(requestFromBru('get {\n  url: https://api.test/\n  auth: bearer\n}', 'R').auth).toEqual({
      type: 'bearer',
      token: '',
    });
    expect(
      requestFromBru(
        'get {\n  url: https://api.test/\n  auth: apikey\n}\nauth:apikey {\n  key: K\n}',
        'R',
      ).auth,
    ).toMatchObject({ in: 'header' });
  });

  it('reads a header assertion written in the dotted form', () => {
    const spec = requestFromBru(
      'get {\n  url: https://api.test/\n}\nassert {\n  res.headers.X-Id: eq 1\n}',
      'R',
    );
    expect(spec.assertions[0]).toMatchObject({ source: 'header', path: 'x-id' });
  });

  it('reads a text body whose block is missing and a ws message list', () => {
    expect(requestFromBru('post {\n  url: https://api.test/\n  body: json\n}', 'R').body).toEqual({
      mode: 'json',
      content: '',
    });
    const ws = requestFromBru('ws {\n  url: ws://api.test\n}\nbody:ws [\n  a\n]', 'R');
    expect(ws.websocket?.messages[0]).toEqual({ content: '' });
  });

  it('reads a proxy whose config has no auth object and no numeric port', () => {
    const { collection } = importBruno([
      {
        path: 'bruno.json',
        content: JSON.stringify({
          name: 'Proxy',
          proxy: { config: { protocol: 'http', hostname: 'proxy.test', port: 'nonsense' } },
        }),
      },
    ]);
    expect(collection.settings?.proxy).toMatchObject({ port: 0 });
    expect(collection.settings?.proxy?.username).toBeUndefined();
  });

  it('sorts two items that share a sequence number by name', () => {
    const { collection } = importBruno([
      { path: 'collection.bru', content: 'meta {\n  name: Same\n}' },
      {
        path: 'b.bru',
        content: 'meta {\n  name: Beta\n  seq: 1\n}\nget {\n  url: https://api.test/b\n}',
      },
      {
        path: 'a.bru',
        content: 'meta {\n  name: Alpha\n  seq: 1\n}\nget {\n  url: https://api.test/a\n}',
      },
    ]);
    expect(collection.items.map((item) => item.name)).toEqual(['Alpha', 'Beta']);
  });

  it('skips a proto file that bruno.json names but the import does not carry', () => {
    const { collection } = importBruno([
      {
        path: 'bruno.json',
        content: JSON.stringify({
          name: 'Protos',
          protobuf: {
            protoFiles: [{ path: './protos/missing.proto' }, { path: 'protos/here.proto' }],
          },
        }),
      },
      { path: 'protos/here.proto', content: 'syntax = "proto3";' },
    ]);
    expect(collection.protoFiles).toEqual([{ name: 'here.proto', content: 'syntax = "proto3";' }]);
  });
});
