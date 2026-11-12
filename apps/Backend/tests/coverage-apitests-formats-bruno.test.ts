import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import {
  environmentFile,
  environmentFromBru,
  exportBruno,
  importBruno,
  parseBru,
  requestFile,
  requestFromBru,
} from '../src/modules/apitests/formats/bruno.js';
import type { ApiRequestSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';

const spec = (extra: Record<string, unknown> = {}): ApiRequestSpec =>
  ({
    id: 'r',
    type: 'request',
    name: 'Req',
    method: 'GET',
    url: 'http://x',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
    ...extra,
  }) as ApiRequestSpec;

const authFile = (auth: unknown) => requestFile(spec({ auth }), 1) ?? '';
const importedAuth = (mode: string, blockText = '') =>
  requestFromBru(`get {\n  url: http://x\n  auth: ${mode}\n}\n${blockText}`, 'n').auth;

describe('bruno writing: auth blocks', () => {
  it('writes each auth type', () => {
    expect(authFile({ type: 'none' })).not.toContain('auth:none');
    expect(authFile(undefined)).toContain('auth: inherit');
    expect(authFile({ type: 'bearer', token: 't' })).toContain('auth:bearer');
    expect(authFile({ type: 'wsse', username: 'u', password: 'p' })).toContain('auth:wsse');
    expect(authFile({ type: 'apikey', key: 'k', value: 'v', in: 'query' })).toContain(
      'placement: queryparams',
    );
    expect(authFile({ type: 'apikey', key: 'k', value: 'v', in: 'header' })).toContain(
      'placement: header',
    );
    expect(
      authFile({
        type: 'awsv4',
        accessKeyId: 'a',
        secretAccessKey: 's',
        service: 'x',
        region: 'r',
      }),
    ).toContain('sessionToken: \n');
    const oauthBase = {
      type: 'oauth2',
      accessTokenUrl: 'u',
      clientId: 'c',
      clientSecret: 's',
    };
    const pw = authFile({ ...oauthBase, grantType: 'password' });
    expect(pw).toContain('username: \n');
    expect(pw).toContain('token_header_prefix: Bearer');
    expect(pw).toContain('credentials_placement: body');
    const full = authFile({
      ...oauthBase,
      grantType: 'password',
      username: 'u',
      password: 'p',
      scope: 'sc',
      credentialsPlacement: 'basic',
      tokenPlacement: 'query',
      tokenQueryKey: 'tk',
    });
    expect(full).toContain('token_query_key: tk');
    expect(full).toContain('basic_auth_header');
    expect(
      authFile({ ...oauthBase, grantType: 'refresh_token', tokenPlacement: 'query' }),
    ).toContain('token_query_key: access_token');
    expect(
      authFile({ ...oauthBase, grantType: 'client_credentials', tokenPrefix: 'Tok' }),
    ).toContain('token_header_prefix: Tok');
    const o1 = authFile({
      type: 'oauth1',
      consumerKey: 'k',
      consumerSecret: 's',
      signatureMethod: 'HMAC-SHA1',
    });
    expect(o1).toContain('access_token: \n');
    expect(o1).toContain('placement: header');
    expect(
      authFile({
        type: 'oauth1',
        consumerKey: 'k',
        consumerSecret: 's',
        token: 't',
        tokenSecret: 'ts',
        realm: 'r',
        addTo: 'query',
        signatureMethod: 'PLAINTEXT',
      }),
    ).toContain('placement: query');
    const edge = authFile({
      type: 'edgegrid',
      accessToken: 'a',
      clientToken: 'c',
      clientSecret: 's',
    });
    expect(edge).toContain('headersToSign: \n');
    expect(edge).toContain('auth: akamai-edgegrid');
    expect(
      authFile({
        type: 'edgegrid',
        accessToken: 'a',
        clientToken: 'c',
        clientSecret: 's',
        headersToSign: 'h',
        maxBodySize: 5,
      }),
    ).toContain('maxBodySize: 5');
  });
});

describe('bruno writing: assertions, bodies, requests', () => {
  it('writes assertion targets and operators', () => {
    const a = (source: string, operator: string, path?: string, expected?: string) => ({
      id: 'x',
      source,
      operator,
      ...(path !== undefined ? { path } : {}),
      ...(expected !== undefined ? { expected } : {}),
    });
    const text =
      requestFile(
        spec({
          assertions: [
            a('status', 'eq', undefined, '200'),
            a('duration', 'lt', undefined, '5'),
            a('header', 'exists'),
            a('header', 'exists', 'X-A'),
            a('body', 'contains', undefined, 'hi'),
            a('json', 'eq', undefined, 'true'),
            a('json', 'neq', '$', 'x'),
            a('json', 'eq', '$.a.b', 'x'),
            a('json', 'notContains', '[0].id', 'x'),
            a('json', 'notExists', 'a'),
            a('json', 'lte', 'a', '1'),
            a('json', 'gt', 'a', '1'),
            a('json', 'gte', 'a', '1'),
            a('json', 'matches', 'a', '^x'),
            a('json', 'isType', 'a', 'String'),
            a('json', 'isType', 'a', 'weird'),
            a('json', 'isType', 'a'),
            a('json', 'eq', 'a'),
          ],
        }),
        1,
      ) ?? '';
    expect(text).toContain('res.status: eq 200');
    expect(text).toContain('res.headers[""]: isDefined');
    expect(text).toContain('res.headers["x-a"]: isDefined');
    expect(text).toContain('res.body: eq true');
    expect(text).toContain('res.body.a.b: eq "x"');
    expect(text).toContain('res.body[0].id: notContains "x"');
    expect(text).toContain('res.body.a: isString');
    expect(text).toContain('res.body.a: isJson');
  });

  it('writes body modes', () => {
    const body = (b: unknown) => requestFile(spec({ body: b }), 1) ?? '';
    expect(body({ mode: 'none' })).not.toContain('body:json');
    expect(body({ mode: 'json', content: '{"a":1}' })).toContain('body:json');
    expect(body({ mode: 'urlencoded', fields: [{ key: 'a', value: 'b' }] })).toContain(
      'body:form-urlencoded',
    );
    const form = body({
      mode: 'form',
      fields: [
        { key: 'f', value: 'v', type: 'file', file: { fileName: 'n.txt' }, contentType: 'x/y' },
        { key: 'g', value: 'orig.txt', type: 'file' },
        { key: 'h', value: 'line1\nline2', type: 'text', enabled: false },
      ],
    });
    expect(form).toContain('f: @file(n.txt) @contentType(x/y)');
    expect(form).toContain('g: @file(orig.txt)');
    expect(form).toContain('~h:');
    expect(body({ mode: 'binary', file: null })).not.toContain('body:file');
    expect(body({ mode: 'binary', file: { fileName: 'a.bin', contentType: 'app/x' } })).toContain(
      '@file(a.bin) @contentType(app/x)',
    );
    expect(body({ mode: 'binary', file: { fileName: 'a.bin' } })).toContain('file: @file(a.bin)\n');
  });

  it('writes grpc, websocket, graphql and socket requests', () => {
    expect(requestFile(spec({ kind: 'socket' }), 1)).toBeNull();
    const grpc = requestFile(
      spec({
        kind: 'grpc',
        grpc: { method: '/pkg.Svc/Do', protoFile: 'a.proto', message: '[{"a":1},{"b":2}]' },
      }),
      1,
    );
    expect(grpc).toContain('protoPath: protos/a.proto');
    expect(grpc).toContain('method: /pkg.Svc/Do');
    expect(grpc?.match(/body:grpc/g)).toHaveLength(2);
    const grpcText = requestFile(
      spec({ kind: 'grpc', grpc: { method: 'Do', message: 'not json' } }),
      1,
    );
    expect(grpcText).toContain('not json');
    expect(requestFile(spec({ kind: 'grpc', grpc: { method: 'Do', message: '5' } }), 1)).toContain(
      '5',
    );
    expect(requestFile(spec({ kind: 'grpc' }), 1)).toContain('method: \n');
    expect(requestFile(spec({ kind: 'grpc', grpc: { method: '', message: '{}' } }), 1)).toContain(
      'method: \n',
    );
    const ws = requestFile(
      spec({
        kind: 'websocket',
        websocket: { messages: [{ content: 'a', type: 'json', name: 'n' }, { content: 'b' }] },
      }),
      1,
    );
    expect(ws).toContain('type: json');
    expect(ws).toContain('name: message 2');
    expect(requestFile(spec({ kind: 'websocket' }), 1)).toContain('body: ws');
    const gql = requestFile(
      spec({ kind: 'graphql', graphql: { query: '', variables: '{"a":1}' } }),
      1,
    );
    expect(gql).toContain('body:graphql');
    expect(gql).toContain('type: graphql');
    expect(requestFile(spec({ kind: 'graphql' }), 1)).toContain('type: http');
  });

  it('writes settings, tags, scripts, vars and docs', () => {
    const text =
      requestFile(
        spec({
          tags: ['a b', '!!!'],
          timeoutMs: 500,
          settings: { encodeUrl: true, followRedirects: false, maxRedirects: 3 },
          description: 'docs',
          vars: [{ key: 'k', value: 'v' }],
          scripts: { preRequest: 'adk.setVar("a", 1)' },
        }),
        2,
      ) ?? '';
    expect(text).toContain('tags: [');
    expect(text).toContain('encodeUrl: true');
    expect(text).toContain('timeout: 500');
    expect(text).toContain('maxRedirects: 3');
    expect(text).toContain('docs {');
    expect(requestFile(spec({ tags: ['!!!'] }), 1)).toContain('tags: [');
  });

  it('writes environment files with secrets and disabled variables', () => {
    const text = environmentFile([
      { key: 'a', value: '1' },
      { key: 'off', value: '1', enabled: false },
      { key: 's', value: 'x', secret: true },
    ]);
    expect(text).toContain('vars:secret [');
    expect(text).not.toContain('off');
    expect(environmentFile([{ key: 'a', value: '1' }])).not.toContain('secret');
  });
});

describe('exportBruno', () => {
  it('exports collection, folders, environments, protos and dedupes names', () => {
    const collection = {
      name: 'My/Col',
      variables: [
        { key: 'a', value: '1' },
        { key: 'sec', value: 'x', secret: true },
      ],
      auth: { type: 'inherit' },
      scriptFlow: 'sandwich',
      settings: {
        proxy: {
          enabled: false,
          protocol: 'http',
          hostname: 'h',
          port: 1,
        },
        clientCertificates: [
          { domain: 'a', type: 'pfx' },
          { domain: 'b', type: 'pem' },
        ],
        presets: {},
      },
      protoFiles: [{ name: 'a.proto', content: 'syntax' }],
      items: [
        spec({ name: 'Dup' }),
        spec({ name: 'dup' }),
        spec({ name: '', kind: 'socket' }),
        {
          id: 'f',
          type: 'folder',
          name: 'Folder',
          auth: { type: 'bearer', token: 't' },
          headers: [{ key: 'h', value: 'v' }],
          vars: [{ key: 'v', value: '1' }],
          scripts: { postResponse: 'x' },
          description: 'd',
          items: [spec({ name: 'Inner' })],
        },
        { id: 'g', type: 'folder', name: 'Bare', items: [] },
      ],
    } as unknown as CollectionInput;
    const files = exportBruno(collection, [
      { name: 'env', variables: [{ key: 's', value: 'x', secret: true }] },
    ]);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('My-Col/Dup.bru');
    expect(paths).toContain('My-Col/dup 2.bru');
    expect(paths).toContain('My-Col/Folder/folder.bru');
    expect(paths).toContain('My-Col/protos/a.proto');
    expect(paths).toContain('My-Col/environments/env.bru');
    const json = JSON.parse(files[0]?.content ?? '{}');
    expect(json.proxy.disabled).toBe(true);
    expect(json.proxy.config.auth.disabled).toBe(true);
    expect(json.presets.requestType).toBe('http');
    expect(json.clientCertificates.certs).toHaveLength(2);
    expect(json.scripts.flow).toBe('sandwich');
    // Round-trip
    const back = importBruno(files);
    expect(back.collection.items.length).toBeGreaterThan(2);
  });

  it('exports a minimal collection', () => {
    const files = exportBruno({
      name: 'Min',
      variables: [],
      auth: { type: 'bearer', token: 't' },
      items: [],
    } as unknown as CollectionInput);
    expect(files).toHaveLength(2);
    const proxy = exportBruno({
      name: 'P',
      variables: [],
      auth: { type: 'none' },
      settings: {
        proxy: {
          enabled: true,
          protocol: 'http',
          hostname: 'h',
          port: 1,
          username: 'u',
          bypass: 'b',
        },
      },
      items: [],
    } as unknown as CollectionInput);
    expect(JSON.parse(proxy[0]?.content ?? '{}').proxy.config.bypassProxy).toBe('b');
  });
});

describe('parseBru', () => {
  it('handles lists, text blocks, quoted keys, annotations and multiline values', () => {
    const blocks = parseBru(
      [
        'meta {',
        '  name: N',
        '  tags: [',
        '    a,',
        '    b',
        '    ',
        '  ]',
        '}',
        'junk line',
        'vars:secret [',
        '  a,',
        '  b',
        ']',
        'headers {',
        '  @description(foo)',
        '  ~"quoted key": v',
        '  "bad key" no colon',
        '  nocolon',
        '  X: @contentType(a/b)',
        "  M: '''",
        '    l1',
        '    l2',
        "  ''' @contentType(t/x)",
        '  @desc: kept',
        '  ',
        '}',
        'docs {',
        '',
        '  hello',
        '}',
        'unclosed {',
        '  a: b',
      ].join('\r\n'),
    );
    expect(blocks.find((b) => b.name === 'vars:secret')?.items).toEqual(['a', 'b']);
    const headers = blocks.find((b) => b.name === 'headers')?.pairs ?? [];
    expect(headers.find((p) => p.key === 'quoted key')?.enabled).toBe(false);
    expect(headers.find((p) => p.key === 'M')?.contentType).toBe('t/x');
    expect(headers.find((p) => p.key === 'X')?.contentType).toBe('a/b');
    expect(blocks.find((b) => b.name === 'docs')?.text).toBe('hello');
    expect(blocks.find((b) => b.name === 'meta')?.pairs?.[1]?.list).toEqual(['a,', 'b']);
  });
});

describe('requestFromBru', () => {
  it('reads a plain request with fallback name and defaults', () => {
    const request = requestFromBru('', 'fallback');
    expect(request.name).toBe('fallback');
    expect(request.method).toBe('GET');
    expect(request.auth).toEqual({ type: 'inherit' });
    expect(request.body).toEqual({ mode: 'none' });
  });

  it('reads the generic http block, unknown methods and metadata', () => {
    const request = requestFromBru(
      [
        'meta {',
        '  name: R',
        '}',
        'http {',
        '  method: bogus',
        '  url: u',
        '}',
        'metadata {',
        '  m: 1',
        '}',
        'query {',
        '  q: 1',
        '}',
        'params:path {',
        '  id: 1',
        '}',
      ].join('\n'),
      'x',
    );
    expect(request.method).toBe('GET');
    expect(request.headers).toHaveLength(1);
    expect(request.query).toHaveLength(1);
    expect(request.pathParams).toHaveLength(1);
    const post = requestFromBru('http {\n  method: post\n}\n', 'x');
    expect(post.method).toBe('POST');
  });

  it('reads body modes', () => {
    const body = (mode: string, extra = '') =>
      requestFromBru(`post {\n  url: u\n  body: ${mode}\n}\n${extra}`, 'x').body;
    expect(body('json', 'body:json {\n  {"a":1}\n}\n')).toEqual({
      mode: 'json',
      content: '{"a":1}',
    });
    expect(body('xml')).toEqual({ mode: 'xml', content: '' });
    expect(body('formUrlEncoded', 'body:form-urlencoded {\n  a: b\n  ~c: d\n}\n')).toEqual({
      mode: 'urlencoded',
      fields: [
        { key: 'a', value: 'b' },
        { key: 'c', value: 'd', enabled: false },
      ],
    });
    const form = body(
      'multipartForm',
      [
        'body:multipart-form {',
        '  a: x @contentType(t/p)',
        '  ~b: @file(C:\\dir\\f1.txt|/tmp/f2.txt)',
        '  c: @file(g.txt) @contentType(ignored)',
        '}',
      ].join('\n'),
    );
    expect(form).toMatchObject({
      mode: 'form',
      fields: [
        { key: 'a', value: 'x', contentType: 't/p' },
        { key: 'b', value: 'f1.txt, f2.txt', enabled: false },
        { key: 'c', value: 'g.txt' },
      ],
    });
    expect(body('file')).toEqual({ mode: 'binary', file: null });
    expect(body('weird')).toEqual({ mode: 'none' });
  });

  it('reads graphql, grpc and websocket requests', () => {
    const gql = requestFromBru(
      'meta {\n  type: graphql\n}\npost {\n  url: u\n  body: graphql\n}\nbody:graphql {\n  { a }\n}\nbody:graphql:vars {\n  {"x":1}\n}\n',
      'x',
    );
    expect(gql).toMatchObject({
      kind: 'graphql',
      graphql: { query: '{ a }', variables: '{"x":1}' },
    });
    const gql2 = requestFromBru('post {\n  body: graphql\n}\n', 'x');
    expect(gql2.graphql).toEqual({ query: '' });
    const grpc = requestFromBru(
      [
        'meta {',
        '  type: grpc',
        '}',
        'grpc {',
        '  url: h',
        '  method: /a.B/C',
        '  protoPath: ./protos/a.proto',
        '  auth: bearer',
        '}',
        'auth:bearer {',
        '  token: t',
        '}',
        'body:grpc {',
        '  name: one',
        "  content: '''",
        '    {"a":1}',
        "  '''",
        '}',
        'body:grpc {',
        "  content: '''",
        '    {"a":2}',
        "  '''",
        '}',
      ].join('\n'),
      'x',
    );
    expect(grpc.grpc?.method).toBe('a.B/C');
    expect(grpc.grpc?.protoFile).toBe('a.proto');
    expect(grpc.grpc?.message.startsWith('[')).toBe(true);
    const grpcDefault = requestFromBru('grpc {\n  url: h\n}\n', 'x');
    expect(grpcDefault.grpc?.message).toBe('{}');
    expect(grpcDefault.auth).toEqual({ type: 'inherit' });
    const grpcOne = requestFromBru(
      "grpc {\n  url: h\n}\nbody:grpc {\n  content: '''\n    {}\n  '''\n}\n",
      'x',
    );
    expect(grpcOne.grpc?.message).toBe('{}');
    const ws = requestFromBru(
      [
        'meta {',
        '  type: ws',
        '}',
        'ws {',
        '  url: w',
        '}',
        'body:ws {',
        '  name: m',
        '  type: json',
        "  content: '''",
        '    {}',
        "  '''",
        '}',
        'body:ws {',
        '  type: weird',
        '}',
      ].join('\n'),
      'x',
    );
    expect(ws.websocket?.messages).toEqual([
      { name: 'm', content: '{}', type: 'json' },
      { content: '' },
    ]);
  });

  it('reads assertions of every operator', () => {
    const lines = [
      'res.status: eq 200',
      'res.getStatus(): neq 1',
      'res.responseTime: lt 100',
      'res.getResponseTime(): gt 1',
      'res.body: contains "x"',
      'res.getBody(): notContains x',
      'res.headers.content-type: matches ^a',
      'res.headers["X-A"]: isDefined',
      "res.headers['X-B']: isUndefined",
      'res.getHeader("X-C"): gte 1',
      'res.body.a.b: isString',
      'res.body.n: isNumber',
      'res.body.b: isBoolean',
      'res.body.l: isArray',
      'res.body.o: isJson',
      'res.body.z: isNull',
      'res.body["k"][0]: startsWith a.b',
      'res.body.e: endsWith x',
      'res.body.q: lte 5',
      'res.body.in: in a,b',
      'res.body.bare: "plain"',
      'res.other: eq 1',
      '~res.body.off: eq 1',
      'res.body.x: ',
    ];
    const text = `get {\n  url: u\n}\nassert {\n${lines.map((l) => `  ${l}`).join('\n')}\n}\n`;
    const { assertions } = requestFromBru(text, 'x');
    const ops = assertions.map((a) => a.operator);
    expect(ops).toContain('isType');
    expect(ops).toContain('exists');
    expect(ops).toContain('notExists');
    expect(assertions.find((a) => a.expected?.startsWith('^a\\.b'))).toBeDefined();
    expect(assertions.find((a) => a.expected === 'x$')).toBeDefined();
    expect(assertions.some((a) => a.path === 'k.[0]' || a.path === 'k[0]')).toBe(true);
    expect(assertions.find((a) => a.expected === 'plain')).toBeDefined();
    expect(assertions.some((a) => a.path === 'in')).toBe(false);
  });

  it('reads captures, vars, scripts, settings, tags and docs', () => {
    const request = requestFromBru(
      [
        'meta {',
        '  name: N',
        '  tags: [',
        '    one',
        '    two',
        '  ]',
        '}',
        'get {',
        '  url: u',
        '}',
        'vars:pre-request {',
        '  a: 1',
        '}',
        'vars:post-response {',
        '  tok: res.body.token',
        '  hdr: res.headers.x',
        '  dur: res.responseTime',
        '  expr: res.body.a + 1',
        '  ~off: res.status',
        '  root: res.body',
        '}',
        'script:pre-request {',
        '  bru.setVar("a", 1)',
        '}',
        'script:post-response {',
        '  bru.setVar("b", 1)',
        '}',
        'tests {',
        '  test("x", () => {})',
        '}',
        'settings {',
        '  encodeUrl: true',
        '  followRedirects: false',
        '  maxRedirects: 4',
        '  timeout: 5000',
        '}',
        'docs {',
        '  some docs',
        '}',
      ].join('\n'),
      'x',
    );
    expect(request.tags).toEqual(['one', 'two']);
    expect(request.vars).toHaveLength(1);
    expect(request.captures.map((c) => c.variable)).toEqual(['tok', 'hdr', 'root']);
    expect(request.scripts?.postResponse).toContain('adk.setVar("expr"');
    expect(request.scripts?.preRequest).toContain('adk');
    expect(request.scripts?.tests).toBeDefined();
    expect(request.settings).toEqual({ encodeUrl: true, followRedirects: false, maxRedirects: 4 });
    expect(request.timeoutMs).toBe(5000);
    expect(request.description).toBe('some docs');
    const low = requestFromBru(
      'get {\n  url: u\n}\nsettings {\n  timeout: 0\n  encodeUrl: \n}\n',
      'x',
    );
    expect(low.timeoutMs).toBeUndefined();
    expect(low.settings).toBeUndefined();
    const onlyExtra = requestFromBru(
      'get {\n  url: u\n}\nvars:post-response {\n  e: 1 + 1\n}\n',
      'x',
    );
    expect(onlyExtra.scripts?.postResponse).toContain('adk.setVar');
  });

  it('reads every auth mode', () => {
    expect(importedAuth('bearer')).toEqual({ type: 'bearer', token: '' });
    expect(importedAuth('inherit')).toEqual({ type: 'inherit' });
    expect(importedAuth('basic', 'auth:basic {\n  username: u\n  password: p\n}\n')).toEqual({
      type: 'basic',
      username: 'u',
      password: 'p',
    });
    expect(
      importedAuth('apikey', 'auth:apikey {\n  key: k\n  placement: queryparams\n}\n'),
    ).toMatchObject({
      in: 'query',
    });
    expect(importedAuth('apikey')).toMatchObject({ in: 'header' });
    expect(
      importedAuth('awsv4', 'auth:awsv4 {\n  accessKeyId: a\n  sessionToken: st\n}\n'),
    ).toMatchObject({ sessionToken: 'st' });
    expect(importedAuth('awsv4')).not.toHaveProperty('sessionToken');
    expect(
      importedAuth(
        'oauth1',
        'auth:oauth1 {\n  access_token: t\n  token_secret: ts\n  realm: r\n  placement: query\n  signature_method: HMAC-SHA256\n}\n',
      ),
    ).toMatchObject({
      token: 't',
      tokenSecret: 'ts',
      realm: 'r',
      addTo: 'query',
      signatureMethod: 'HMAC-SHA256',
    });
    expect(
      importedAuth('oauth1', 'auth:oauth1 {\n  signature_method: PLAINTEXT\n}\n'),
    ).toMatchObject({
      signatureMethod: 'PLAINTEXT',
      addTo: 'header',
    });
    const o1 = importedAuth(
      'oauth1',
      'auth:oauth1 {\n  signature_method: RSA-SHA1\n}\n',
    ) as RequestAuth;
    expect(o1).toMatchObject({ signatureMethod: 'HMAC-SHA1' });
    expect(o1).not.toHaveProperty('token');
    expect(
      importedAuth(
        'akamai-edgegrid',
        'auth:akamai-edgegrid {\n  headersToSign: h\n  maxBodySize: 10\n}\n',
      ),
    ).toMatchObject({ headersToSign: 'h', maxBodySize: 10 });
    expect(importedAuth('akamai-edgegrid')).not.toHaveProperty('maxBodySize');
    expect(importedAuth('ntlm')).toEqual({ type: 'none' });
  });

  it('reads oauth2 variants', () => {
    expect(importedAuth('oauth2', 'auth:oauth2 {\n  grant_type: authorization_code\n}\n')).toEqual({
      type: 'none',
    });
    expect(
      importedAuth(
        'oauth2',
        'auth:oauth2 {\n  grant_type: password\n  username: u\n  password: p\n  scope: s\n  credentials_placement: basic_auth_header\n  token_placement: url\n  token_query_key: tk\n}\n',
      ),
    ).toMatchObject({
      grantType: 'password',
      username: 'u',
      scope: 's',
      credentialsPlacement: 'basic',
      tokenPlacement: 'query',
      tokenQueryKey: 'tk',
    });
    expect(
      importedAuth(
        'oauth2',
        'auth:oauth2 {\n  grant_type: client_credentials\n  token_placement: url\n}\n',
      ),
    ).toMatchObject({ tokenQueryKey: 'access_token' });
    expect(
      importedAuth(
        'oauth2',
        'auth:oauth2 {\n  grant_type: client_credentials\n  token_header_prefix: Tok\n}\n',
      ),
    ).toMatchObject({ tokenPrefix: 'Tok' });
    expect(
      importedAuth('oauth2', 'auth:oauth2 {\n  grant_type: client_credentials\n}\n'),
    ).not.toHaveProperty('tokenPrefix');
  });
});

describe('environmentFromBru', () => {
  it('reads variables and secrets', () => {
    expect(environmentFromBru('e', 'vars {\n  a: 1\n}\nvars:secret [\n  ~s,\n  t\n]\n')).toEqual({
      name: 'e',
      variables: [
        { key: 'a', value: '1' },
        { key: 's', value: '', secret: true },
        { key: 't', value: '', secret: true },
      ],
    });
    expect(environmentFromBru('e', '').variables).toEqual([]);
  });
});

describe('importBruno', () => {
  const brunoJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: 'C', ...extra });

  it('imports a full tree with ordering, folders, environments and config', () => {
    const files = [
      {
        path: 'root\\bruno.json',
        content: brunoJson({
          scripts: { flow: 'sequential' },
          protobuf: {
            protoFiles: [{ path: './protos/a.proto' }, { path: 'protos/missing.proto' }, 5],
          },
          proxy: {
            enabled: true,
            protocol: 'socks5',
            hostname: 'h',
            port: '8080',
            auth: { username: 'u' },
            bypassProxy: 'b',
          },
          clientCertificates: {
            certs: [{ domain: 'd', type: 'pfx' }, { domain: 'e' }, { type: 'x' }],
          },
          presets: { requestType: 'ws', requestUrl: 'http://base' },
        }),
      },
      {
        path: './root/collection.bru',
        content:
          'auth {\n  mode: bearer\n}\nauth:bearer {\n  token: t\n}\nheaders {\n  h: 1\n}\nscript:pre-request {\n  bru.x()\n}\ndocs {\n  hi\n}\nvars:pre-request {\n  v: 1\n}\n',
      },
      { path: 'root/protos/a.proto', content: 'syntax' },
      { path: 'root/environments/dev.bru', content: 'vars {\n  a: 1\n}\n' },
      { path: 'root/z.bru', content: 'meta {\n  name: Zed\n  seq: 2\n}\nget {\n  url: u\n}\n' },
      { path: 'root/a.bru', content: 'meta {\n  name: Aaa\n  seq: 2\n}\nget {\n  url: u\n}\n' },
      { path: 'root/noseq.bru', content: 'get {\n  url: u\n}\n' },
      {
        path: 'root/sub/folder.bru',
        content:
          'meta {\n  name: Sub\n  seq: 1\n}\nheaders {\n  fh: 1\n}\nauth {\n  mode: inherit\n}\nvars:pre-request {\n  fv: 1\n}\nscript:pre-request {\n  bru.x()\n}\ndocs {\n  fd\n}\n',
      },
      { path: 'root/sub/inner.bru', content: 'get {\n  url: u\n}\n' },
      { path: 'root/implicit/deep/x.bru', content: 'get {\n  url: u\n}\n' },
      { path: 'outside/other.bru', content: 'get {\n  url: u\n}\n' },
      { path: 'root/readme.md', content: 'ignored' },
    ];
    const { collection, environments } = importBruno(files);
    expect(collection.name).toBe('C');
    expect(collection.scriptFlow).toBe('sequential');
    expect(collection.auth).toEqual({ type: 'bearer', token: 't' });
    expect(collection.description).toBe('hi');
    expect(collection.headers).toHaveLength(1);
    expect(collection.scripts).toBeDefined();
    expect(collection.protoFiles).toEqual([{ name: 'a.proto', content: 'syntax' }]);
    expect(collection.settings?.proxy).toMatchObject({
      enabled: true,
      protocol: 'socks5',
      port: 8080,
      username: 'u',
      bypass: 'b',
    });
    expect(collection.settings?.clientCertificates).toEqual([
      { domain: 'd', type: 'pfx' },
      { domain: 'e', type: 'pem' },
    ]);
    expect(collection.settings?.presets).toEqual({ kind: 'websocket', baseUrl: 'http://base' });
    expect(environments).toHaveLength(1);
    const names = collection.items.map((i) => i.name);
    expect(names[0]).toBe('Sub');
    expect(names.slice(1, 3)).toEqual(['Aaa', 'Zed']);
    const sub = collection.items[0];
    expect(sub).toMatchObject({ type: 'folder', description: 'fd' });
  });

  it('handles empty input, a single request, a bad bruno.json and nameless collection', () => {
    expect(importBruno([]).collection.name).toBe('Bruno collection');
    expect(
      importBruno([
        { path: 'bruno.json', content: '{bad' },
        { path: 'a.bru', content: 'get {\n}\n' },
      ]).collection.items,
    ).toHaveLength(1);
    expect(importBruno([{ path: 'bruno.json', content: '[]' }]).collection.items).toEqual([]);
    const named = importBruno([
      { path: 'x/collection.bru', content: 'meta {\n  name: FromBru\n}\n' },
      { path: 'x/r.bru', content: 'get {\n}\n' },
    ]);
    expect(named.collection.name).toBe('FromBru');
    expect(named.collection.auth).toEqual({ type: 'none' });
    const inheritCollection = importBruno([
      { path: 'collection.bru', content: 'auth {\n  mode: inherit\n}\n' },
    ]);
    expect(inheritCollection.collection.auth).toEqual({ type: 'none' });
  });

  it('reads proxy variants', () => {
    const settings = (proxy: unknown, extra: Record<string, unknown> = {}) =>
      importBruno([{ path: 'bruno.json', content: JSON.stringify({ proxy, ...extra }) }]).collection
        .settings;
    expect(settings({ inherit: true, hostname: 'h' })).toBeUndefined();
    expect(settings({ hostname: '' })).toBeUndefined();
    expect(
      settings({
        config: { hostname: 'h', protocol: 'https', auth: { username: 'u', disabled: true } },
        disabled: true,
      })?.proxy,
    ).toEqual({ enabled: false, protocol: 'https', hostname: 'h', port: 0 });
    expect(settings({ hostname: 'h', protocol: 'weird', enabled: false })?.proxy).toMatchObject({
      enabled: false,
      protocol: 'http',
    });
    expect(
      settings({ config: { hostname: 'h', auth: { username: 'u', enabled: false } } })?.proxy,
    ).not.toHaveProperty('username');
    expect(settings({}, { presets: { requestType: 'bogus' } })?.presets).toEqual({});
    expect(settings({}, { clientCertificates: { certs: [] }, presets: 'x' })).toBeUndefined();
    expect(settings({}, { clientCertificates: {} })).toBeUndefined();
  });
});

describe('bruno edge cases', () => {
  it('falls back to a placeholder file name and keeps blank lines of multiline values', () => {
    const files = exportBruno({
      name: '///',
      variables: [],
      auth: { type: 'none' },
      settings: { presets: { kind: 'bogus' } },
      items: [spec({ headers: [{ key: 'h', value: 'a\n\nb' }] })],
    } as unknown as CollectionInput);
    expect(files[0]?.path).toBe('-/bruno.json');
    expect(JSON.parse(files[0]?.content ?? '{}').presets.requestType).toBe('http');
    expect(files.at(-1)?.content).toMatch(/a\n\n\s+b/);
    const empty = exportBruno({
      name: '   ',
      variables: [],
      auth: { type: 'none' },
      items: [],
    } as unknown as CollectionInput);
    expect(empty[0]?.path).toBe('untitled/bruno.json');
  });

  it('tolerates an unterminated multiline value', () => {
    const blocks = parseBru("headers {\n  a: '''\n    x\n");
    expect(blocks[0]?.pairs?.[0]).toMatchObject({ key: 'a', value: 'x\n' });
  });
});
