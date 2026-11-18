import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import {
  INSOMNIA_SCRIPT_NOTE,
  exportInsomnia,
  importInsomnia,
  isInsomniaExport,
} from '../src/modules/apitests/formats/insomnia.js';
import type { ApiItem, ApiRequestSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';

type Json = Record<string, unknown>;

const doc = (resources: Json[]): Json => ({ _type: 'export', resources });
const workspace: Json = { _id: 'w', _type: 'workspace', name: 'WS', description: 'About' };
const requestResource = (extra: Json = {}): Json => ({
  _id: 'r1',
  _type: 'request',
  parentId: 'w',
  name: 'Req',
  method: 'get',
  url: '{{ _.base }}/x',
  ...extra,
});
const importRequest = (extra: Json = {}, wrapper: Json[] = []): ApiRequestSpec =>
  importInsomnia(doc([workspace, ...wrapper, requestResource(extra)])).items[0] as ApiRequestSpec;
const importAuth = (authentication: unknown) => importRequest({ authentication }).auth;

describe('isInsomniaExport', () => {
  it('requires an export envelope with resources', () => {
    expect(isInsomniaExport({ _type: 'export', resources: [] })).toBe(true);
    expect(isInsomniaExport({ _type: 'export' })).toBe(false);
    expect(isInsomniaExport(null)).toBe(false);
  });
});

describe('Insomnia import', () => {
  it('uses defaults for an empty export', () => {
    expect(importInsomnia({})).toEqual({
      name: 'Insomnia collection',
      variables: [],
      auth: { type: 'none' },
      items: [],
    });
  });

  it('reads the workspace, base environment, folders and ordering', () => {
    const imported = importInsomnia(
      doc([
        workspace,
        {
          _id: 'env',
          _type: 'environment',
          parentId: 'w',
          data: { base: 'http://x', n: 2, s: '{{ _.a }}' },
        },
        { _id: 'env2', _type: 'environment', parentId: 'env', data: { ignored: 1 } },
        { _id: 'f1', _type: 'request_group', parentId: 'w', name: '', metaSortKey: 2 },
        {
          _id: 'f2',
          _type: 'request_group',
          parentId: 'w',
          name: 'Named',
          description: 'Folder notes',
          metaSortKey: 1,
          authentication: { type: 'bearer', token: '{{ _.t }}' },
          environment: { a: 'x{{ _.b }}', n: 3 },
          preRequestScript: 'insomnia.x()',
        },
        { _id: 'inner', _type: 'request', parentId: 'f2', name: '', method: 'post', url: '' },
        { _id: 'other', _type: 'cookie_jar', parentId: 'w' },
        { _id: 'late', _type: 'request', parentId: 'w', method: 'weird' },
      ]),
    );
    expect(imported.name).toBe('WS');
    expect(imported.description).toBe('About');
    expect(imported.variables).toEqual([
      { key: 'base', value: 'http://x' },
      { key: 'n', value: '2' },
      { key: 's', value: '{{a}}' },
    ]);
    const [late, named, bare] = imported.items as unknown as [Json, Json, Json];
    expect(named).toMatchObject({
      name: 'Named',
      type: 'folder',
      auth: { type: 'bearer', token: '{{t}}' },
      vars: [
        { key: 'a', value: 'x{{b}}' },
        { key: 'n', value: '3' },
      ],
      scripts: { preRequest: 'adk.x()' },
    });
    expect(String(named['description'])).toContain(INSOMNIA_SCRIPT_NOTE);
    expect(bare).toMatchObject({ name: 'Folder', items: [] });
    expect(bare).not.toHaveProperty('auth');
    expect((named['items'] as Json[])[0]).toMatchObject({ name: 'Request', method: 'POST' });
    expect(late).toMatchObject({ name: 'Request', method: 'GET' });
  });

  it('reads parameters, headers and bodies', () => {
    const request = importRequest({
      headers: [{ name: 'X-A', value: '{{ _.v }}', disabled: true }, 'junk'],
      parameters: [{ name: 'q', value: '1' }],
      body: { mimeType: 'application/json', text: '{"a":"{{ _.b }}"}' },
    });
    expect(request.headers).toEqual([{ key: 'X-A', value: '{{v}}', enabled: false }]);
    expect(request.query).toEqual([{ key: 'q', value: '1' }]);
    expect(request.body).toEqual({ mode: 'json', content: '{"a":"{{b}}"}' });
    expect(request.url).toBe('{{base}}/x');

    const bodyOf = (body: unknown) => importRequest({ body }).body;
    expect(bodyOf(undefined)).toEqual({ mode: 'none' });
    expect(bodyOf({ mimeType: 'text/xml', text: '<a/>' })).toEqual({
      mode: 'xml',
      content: '<a/>',
    });
    expect(bodyOf({ mimeType: 'text/plain', text: 'hi' })).toEqual({ mode: 'text', content: 'hi' });
    expect(bodyOf({ mimeType: 'text/plain' })).toEqual({ mode: 'none' });
    expect(bodyOf({ mimeType: 'application/octet-stream' })).toEqual({
      mode: 'binary',
      file: null,
    });
    expect(
      bodyOf({
        mimeType: 'application/x-www-form-urlencoded',
        params: [{ name: 'a', value: '1', disabled: true }],
      }),
    ).toEqual({ mode: 'urlencoded', fields: [{ key: 'a', value: '1', enabled: false }] });
    expect(
      bodyOf({
        mimeType: 'multipart/form-data',
        params: [
          { name: 'file', type: 'file', fileName: 'C:\\tmp\\a.png' },
          { name: 'file2', type: 'file', fileName: undefined },
          { name: 'text', value: '{{ _.x }}', disabled: true },
          'junk',
        ],
      }),
    ).toEqual({
      mode: 'form',
      fields: [
        { key: 'file', value: 'a.png', type: 'text' },
        { key: 'file2', value: '', type: 'text' },
        { key: 'text', value: '{{x}}', type: 'text', enabled: false },
      ],
    });
  });

  it('reads GraphQL bodies, tolerating invalid JSON', () => {
    const graphql = (text: unknown, extra: Json = {}) =>
      importRequest({ body: { mimeType: 'application/graphql', text, ...extra } });
    const full = graphql(
      JSON.stringify({ query: '{ a }', variables: { x: '{{ _.v }}' }, operationName: 'Op' }),
    );
    expect(full).toMatchObject({
      kind: 'graphql',
      body: { mode: 'none' },
      graphql: { query: '{ a }', operationName: 'Op' },
    });
    expect(full.graphql!.variables).toContain('{{v}}');
    expect(graphql('{ raw query').graphql).toEqual({ query: '{ raw query' });
    expect(graphql(undefined).graphql).toEqual({ query: '' });
    expect(graphql('[1]').graphql).toEqual({ query: '' });
    expect(graphql(JSON.stringify({ query: 'q', variables: {} })).graphql).toEqual({ query: 'q' });
    expect(graphql(JSON.stringify({ query: 'q', variables: 3 })).graphql).toEqual({ query: 'q' });
  });

  it('reads scripts and request settings', () => {
    const withScripts = importRequest({
      description: 'Notes',
      preRequestScript: ' insomnia.a() ',
      afterResponseScript: 'pm.b()',
    });
    expect(withScripts.scripts).toEqual({ preRequest: 'adk.a()', postResponse: 'adk.b()' });
    expect(withScripts.description).toBe(`Notes\n\n${INSOMNIA_SCRIPT_NOTE}`);
    expect(importRequest({ afterResponseScript: 'bru.c()' }).scripts).toEqual({
      postResponse: 'adk.c()',
    });
    expect(importRequest({}).scripts).toBeUndefined();
    expect(importRequest({}).description).toBeUndefined();
    expect(importRequest({ settingFollowRedirects: 'on' }).settings).toEqual({
      followRedirects: true,
    });
    expect(
      importRequest({ settingFollowRedirects: 'off', settingEncodeUrl: false }).settings,
    ).toEqual({
      followRedirects: false,
      encodeUrl: false,
    });
    expect(
      importRequest({ settingFollowRedirects: 'global', settingEncodeUrl: true }).settings,
    ).toBeUndefined();
  });

  it('maps authentication types', () => {
    expect(importAuth(undefined)).toEqual({ type: 'inherit' });
    expect(importAuth({ type: '' })).toEqual({ type: 'inherit' });
    expect(importAuth({ type: 'bearer', disabled: true })).toEqual({ type: 'inherit' });
    expect(importAuth({ type: 'bearer', token: '{{ _.t }}' })).toEqual({
      type: 'bearer',
      token: '{{t}}',
    });
    expect(importAuth({ type: 'basic', username: 'u', password: 'p' })).toEqual({
      type: 'basic',
      username: 'u',
      password: 'p',
    });
    expect(importAuth({ type: 'digest', username: 'u', password: 'p' })).toMatchObject({
      type: 'digest',
    });
    expect(importAuth({ type: 'apikey', key: 'k', value: 'v', addTo: 'queryParams' })).toEqual({
      type: 'apikey',
      key: 'k',
      value: 'v',
      in: 'query',
    });
    expect(importAuth({ type: 'apikey', value: 'v' })).toEqual({
      type: 'apikey',
      key: 'X-API-Key',
      value: 'v',
      in: 'header',
    });
    expect(importAuth({ type: 'hawk' })).toEqual({ type: 'none' });
  });

  it('maps OAuth, AWS and OAuth 1 authentication', () => {
    expect(importAuth({ type: 'oauth2', grantType: 'authorization_code' })).toEqual({
      type: 'none',
    });
    expect(
      importAuth({
        type: 'oauth2',
        grantType: 'password',
        accessTokenUrl: 'u',
        clientId: 'c',
        clientSecret: 's',
        username: 'user',
        password: 'pw',
        refreshToken: 'r',
        scope: 'sc',
        audience: 'aud',
        credentialsInBody: true,
        tokenPrefix: 'Token',
      }),
    ).toEqual({
      type: 'oauth2',
      grantType: 'password',
      accessTokenUrl: 'u',
      clientId: 'c',
      clientSecret: 's',
      username: 'user',
      password: 'pw',
      refreshToken: 'r',
      scope: 'sc',
      audience: 'aud',
      credentialsPlacement: 'body',
      tokenPrefix: 'Token',
    });
    expect(importAuth({ type: 'oauth2', grantType: 'client_credentials' })).toMatchObject({
      credentialsPlacement: 'basic',
    });
    expect(importAuth({ type: 'oauth2', grantType: 'refresh_token' })).toMatchObject({
      grantType: 'refresh_token',
    });
    expect(
      importAuth({
        type: 'iam',
        accessKeyId: 'a',
        secretAccessKey: 's',
        sessionToken: 't',
        service: 'sv',
        region: 'r',
      }),
    ).toEqual({
      type: 'awsv4',
      accessKeyId: 'a',
      secretAccessKey: 's',
      sessionToken: 't',
      service: 'sv',
      region: 'r',
    });
    expect(importAuth({ type: 'iam' })).not.toHaveProperty('sessionToken');
    const oauth1 = importAuth({
      type: 'oauth1',
      consumerKey: 'k',
      consumerSecret: 's',
      tokenKey: 't',
      tokenSecret: 'ts',
      signatureMethod: 'PLAINTEXT',
      realm: 'rl',
    });
    expect(oauth1).toEqual({
      type: 'oauth1',
      consumerKey: 'k',
      consumerSecret: 's',
      token: 't',
      tokenSecret: 'ts',
      signatureMethod: 'PLAINTEXT',
      realm: 'rl',
    });
    expect(importAuth({ type: 'oauth1', signatureMethod: 'HMAC-SHA256' })).toMatchObject({
      signatureMethod: 'HMAC-SHA256',
    });
    expect(importAuth({ type: 'oauth1', signatureMethod: 'RSA-SHA1' })).toMatchObject({
      signatureMethod: 'HMAC-SHA1',
    });
  });
});

const request = (extra: Partial<ApiRequestSpec> = {}): ApiRequestSpec =>
  ({
    id: 'r',
    type: 'request',
    name: 'Req',
    method: 'GET',
    url: '{{base}}/x',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
    ...extra,
  }) as ApiRequestSpec;

const exported = (items: ApiItem[], options = {}, auth: RequestAuth = { type: 'none' }) =>
  (
    exportInsomnia({ name: 'C', variables: [], auth, items } as unknown as CollectionInput, options)
      .resources as Json[]
  ).filter((resource) => resource['_type'] === 'request' || resource['_type'] === 'request_group');

const requestOf = (extra: Partial<ApiRequestSpec>, auth?: RequestAuth) =>
  exported([request(extra)], {}, auth)[0]!;

describe('Insomnia export', () => {
  it('writes the workspace and environments, hiding secrets', () => {
    const file = exportInsomnia(
      {
        name: 'C',
        variables: [
          { key: 'a', value: '1' },
          { key: 's', value: 'secret', secret: true },
          { key: 'off', value: 'x', enabled: false },
        ],
        auth: { type: 'none' },
        items: [],
      } as unknown as CollectionInput,
      { environments: [{ name: 'Prod', variables: [{ key: 'a', value: '2' }] }] },
    );
    const resources = file['resources'] as Json[];
    expect(resources[0]).toMatchObject({ _type: 'workspace', description: '' });
    expect(resources[1]!['data']).toEqual({ a: '1', s: '' });
    expect(resources[2]).toMatchObject({ name: 'Prod', data: { a: '2' } });
    const described = exportInsomnia({
      name: 'D',
      description: 'Docs',
      variables: [],
      auth: { type: 'none' },
      items: [],
    } as unknown as CollectionInput);
    expect((described['resources'] as Json[])[0]!['description']).toBe('Docs');
  });

  it('writes folders with inherited auth, variables and scripts', () => {
    const resources = exported(
      [
        {
          id: 'f',
          type: 'folder',
          name: 'F',
          auth: { type: 'bearer', token: '{{t}}' },
          vars: [{ key: 'v', value: '{{x}}' }],
          scripts: { preRequest: 'adk.a()' },
          items: [request({ name: 'In folder' }), request({ name: 'Own', auth: { type: 'none' } })],
        } as ApiItem,
        {
          id: 'g',
          type: 'folder',
          name: 'G',
          description: 'Notes',
          auth: { type: 'inherit' },
          items: [request({ name: 'Plain' })],
        } as ApiItem,
        { id: 'h', type: 'folder', name: 'H', items: [request({ name: 'Bare' })] } as ApiItem,
        request({ name: 'Top' }),
      ],
      {},
      { type: 'basic', username: 'u', password: 'p' },
    );
    const byName = (name: string) => resources.find((resource) => resource['name'] === name)!;
    expect(byName('F')).toMatchObject({
      environment: { v: '{{ _.x }}' },
      authentication: { type: 'bearer', token: '{{ _.t }}' },
      preRequestScript: 'insomnia.a()',
    });
    expect(byName('G')).toMatchObject({ description: 'Notes' });
    expect(byName('G')).not.toHaveProperty('authentication');
    expect(byName('H')).toMatchObject({ description: '' });
    expect(byName('In folder')['authentication']).toMatchObject({ type: 'bearer' });
    expect(byName('Own')['authentication']).toEqual({ type: 'none' });
    expect(byName('Plain')['authentication']).toMatchObject({ type: 'basic' });
    expect(byName('Top')['authentication']).toMatchObject({ type: 'basic' });
  });

  it('skips request kinds Insomnia v4 cannot hold and exports GraphQL', () => {
    const resources = exported([
      request({ name: 'grpc', kind: 'grpc' }),
      request({ name: 'ws', kind: 'websocket' }),
      request({ name: 'sock', kind: 'socket' }),
      request({ name: 'sse', kind: 'sse' as never }),
      request({
        name: 'gql',
        kind: 'graphql',
        graphql: { query: '{ a }', variables: '{"x":"{{v}}"}', operationName: 'Op' },
      }),
      request({ name: 'gql2', kind: 'graphql', graphql: { query: '{ b }', variables: '{bad' } }),
      request({ name: 'gql3', kind: 'graphql' }),
    ]);
    expect(resources.map((resource) => resource['name'])).toEqual(['sse', 'gql', 'gql2', 'gql3']);
    const gql = resources[1]!['body'] as Json;
    expect(gql['mimeType']).toBe('application/graphql');
    expect(JSON.parse(String(gql['text']))).toMatchObject({ query: '{ a }', operationName: 'Op' });
    expect(JSON.parse(String((resources[2]!['body'] as Json)['text']))).toEqual({
      query: '{ b }',
      variables: {},
    });
    expect(JSON.parse(String((resources[3]!['body'] as Json)['text']))).toEqual({
      query: '',
      variables: {},
    });
  });

  it('exports every body mode', () => {
    const body = (value: ApiRequestSpec['body']) => requestOf({ body: value })['body'] as Json;
    expect(body({ mode: 'none' })).toEqual({});
    expect(body({ mode: 'json', content: '{{a}}' })).toEqual({
      mimeType: 'application/json',
      text: '{{ _.a }}',
    });
    expect(body({ mode: 'xml', content: 'x' }).mimeType).toBe('application/xml');
    expect(body({ mode: 'text', content: 'x' }).mimeType).toBe('text/plain');
    expect(body({ mode: 'sparql', content: 'x' }).mimeType).toBe('application/sparql-query');
    expect(
      body({ mode: 'urlencoded', fields: [{ key: 'a', value: '{{b}}', enabled: false }] }).params,
    ).toEqual([{ name: 'a', value: '{{ _.b }}', disabled: true }]);
    expect(
      body({
        mode: 'form',
        fields: [
          { key: 'f', value: 'v', type: 'file', file: { fileName: 'a.png' } },
          { key: 'g', value: 'name.txt', type: 'file' },
          { key: 't', value: '{{x}}', type: 'text', enabled: false },
        ],
      } as never).params,
    ).toEqual([
      { name: 'f', type: 'file', fileName: 'a.png', disabled: false },
      { name: 'g', type: 'file', fileName: 'name.txt', disabled: false },
      { name: 't', value: '{{ _.x }}', disabled: true },
    ]);
    expect(body({ mode: 'binary', file: { fileName: 'b.bin' } } as never).fileName).toBe('b.bin');
    expect(body({ mode: 'binary', file: null }).fileName).toBe('');
  });

  it('exports every authentication type', () => {
    const auth = (value: RequestAuth) => requestOf({ auth: value })['authentication'] as Json;
    expect(auth({ type: 'none' })).toEqual({ type: 'none' });
    expect(auth({ type: 'wsse' } as never)).toEqual({ type: 'none' });
    expect(auth({ type: 'edgegrid' } as never)).toEqual({ type: 'none' });
    expect(auth({ type: 'bearer', token: '{{t}}' })).toEqual({
      type: 'bearer',
      token: '{{ _.t }}',
    });
    expect(auth({ type: 'basic', username: 'u', password: 'p' })).toMatchObject({ type: 'basic' });
    expect(auth({ type: 'digest', username: 'u', password: 'p' })).toMatchObject({
      type: 'digest',
    });
    expect(auth({ type: 'apikey', key: 'k', value: 'v', in: 'query' })).toMatchObject({
      addTo: 'queryParams',
    });
    expect(auth({ type: 'apikey', key: 'k', value: 'v', in: 'header' })).toMatchObject({
      addTo: 'header',
    });
    expect(
      auth({
        type: 'oauth2',
        grantType: 'password',
        accessTokenUrl: 'u',
        clientId: 'c',
        clientSecret: 's',
        username: 'a',
        password: 'b',
        refreshToken: 'r',
        scope: 'sc',
        audience: 'au',
        credentialsPlacement: 'basic',
        tokenPrefix: 'T',
      }),
    ).toMatchObject({ username: 'a', scope: 'sc', credentialsInBody: false, tokenPrefix: 'T' });
    expect(
      auth({
        type: 'oauth2',
        grantType: 'client_credentials',
        accessTokenUrl: 'u',
        clientId: 'c',
        clientSecret: 's',
      }),
    ).toMatchObject({ username: '', scope: '', credentialsInBody: true, tokenPrefix: '' });
    expect(
      auth({
        type: 'awsv4',
        accessKeyId: 'a',
        secretAccessKey: 's',
        sessionToken: 't',
        service: 'x',
        region: 'y',
      }),
    ).toMatchObject({ type: 'iam', sessionToken: 't' });
    expect(
      auth({ type: 'awsv4', accessKeyId: 'a', secretAccessKey: 's', service: 'x', region: 'y' }),
    ).toMatchObject({
      sessionToken: '',
    });
    expect(
      auth({
        type: 'oauth1',
        consumerKey: 'k',
        consumerSecret: 's',
        token: 't',
        tokenSecret: 'ts',
        signatureMethod: 'HMAC-SHA1',
        realm: 'r',
      }),
    ).toMatchObject({ tokenKey: 't', realm: 'r' });
    expect(
      auth({ type: 'oauth1', consumerKey: 'k', consumerSecret: 's', signatureMethod: 'HMAC-SHA1' }),
    ).toMatchObject({ tokenKey: '', tokenSecret: '', realm: '' });
    expect(requestOf({ auth: { type: 'inherit' } }, { type: 'inherit' })['authentication']).toEqual(
      {},
    );
  });

  it('documents checks and captures, and writes scripts and settings', () => {
    const plain = requestOf({});
    expect(plain['description']).toBe('');
    expect(plain).not.toHaveProperty('preRequestScript');
    expect(plain).not.toHaveProperty('afterResponseScript');
    const rich = requestOf({
      description: 'About',
      headers: [{ key: 'X', value: '{{v}}', enabled: false }],
      query: [{ key: 'q', value: '1' }],
      assertions: [
        { id: 'a', source: 'status', operator: 'eq', expected: '200' },
        { id: 'b', source: 'json', path: 'a.b', operator: 'exists' },
      ] as never,
      captures: [
        { variable: 'id', source: 'json', path: 'data.id' },
        { variable: 'st', source: 'status' },
      ] as never,
      scripts: { preRequest: 'adk.pre()', postResponse: 'adk.post()', tests: 'adk.test()' },
      settings: { followRedirects: false, encodeUrl: true },
    });
    expect(String(rich['description'])).toContain('About');
    expect(String(rich['description'])).toContain(
      'Checks (ADK):\n- status eq 200\n- json a.b exists',
    );
    expect(String(rich['description'])).toContain(
      'Captures (ADK):\n- id ← json data.id\n- st ← status',
    );
    expect(rich).toMatchObject({
      preRequestScript: 'insomnia.pre()',
      afterResponseScript: 'insomnia.post()\ninsomnia.test()',
      settingFollowRedirects: 'off',
      settingEncodeUrl: true,
    });
    expect(requestOf({ settings: { followRedirects: true } })).toMatchObject({
      settingFollowRedirects: 'on',
    });
    expect(requestOf({ settings: {} })).not.toHaveProperty('settingFollowRedirects');
    expect(requestOf({ scripts: { preRequest: '  ' } })).not.toHaveProperty('preRequestScript');
  });

  it('writes executable checks as after-response scripts on request', () => {
    const [resource] = exported(
      [
        request({
          assertions: [{ id: 'a', source: 'status', operator: 'eq', expected: '200' }] as never,
        }),
      ],
      { executableChecks: true },
    );
    expect(String(resource!['afterResponseScript'])).toContain('insomnia.');
    const [without] = exported([request()], { executableChecks: true });
    expect(String(without!['afterResponseScript'] ?? '')).not.toContain('adk.');
  });
});

describe('Insomnia import of non-text values', () => {
  it('reads numbers and booleans as text', () => {
    const request = importRequest({ name: 5, url: true });
    expect(request).toMatchObject({ name: '5', url: 'true' });
  });
});
