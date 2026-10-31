import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import type { ApiRequestSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';
import { exportInsomnia, importInsomnia } from '../src/modules/apitests/formats/insomnia.js';

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

const collection = (
  items: CollectionInput['items'],
  extra: Partial<CollectionInput> = {},
): CollectionInput => ({ name: 'All', variables: [], auth: { type: 'none' }, items, ...extra });

const document = (resources: readonly Record<string, unknown>[]) => ({
  _type: 'export',
  resources: [{ _type: 'workspace', _id: 'w', name: 'W' }, ...resources],
});

describe('importInsomnia reads the fields Insomnia leaves out', () => {
  it('reads an oauth1 auth with and without its optional fields', () => {
    const auth = (authentication: Record<string, unknown>) =>
      (
        importInsomnia(
          document([
            { _type: 'request', _id: 'r', parentId: 'w', name: 'R', url: 'https://a.test/', authentication },
          ]) as never,
        ).items[0] as ApiRequestSpec
      ).auth;

    expect(
      auth({
        type: 'oauth1',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenKey: 't',
        tokenSecret: 'ts',
        realm: 'r',
        signatureMethod: 'HMAC-SHA256',
      }),
    ).toMatchObject({ token: 't', tokenSecret: 'ts', realm: 'r', signatureMethod: 'HMAC-SHA256' });
    const bare = auth({ type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs' });
    expect(bare).toMatchObject({ signatureMethod: 'HMAC-SHA1' });
    expect(bare).not.toHaveProperty('token');
    expect(auth({ type: 'oauth1', signatureMethod: 'RSA-SHA1' })).toMatchObject({
      signatureMethod: 'HMAC-SHA1',
    });
    expect(auth({ type: 'oauth1', signatureMethod: 'PLAINTEXT' })).toMatchObject({
      signatureMethod: 'PLAINTEXT',
    });
    expect(auth({ type: 'hawk', id: 'x' })).toEqual({ type: 'none' });
    expect(auth({ type: 'bearer', token: 't', disabled: true })).toEqual({ type: 'inherit' });
  });

  it('reads disabled headers, query rows and form fields', () => {
    const spec = importInsomnia(
      document([
        {
          _type: 'request',
          _id: 'r',
          parentId: 'w',
          name: 'R',
          url: 'https://a.test/',
          headers: [{ name: 'x-a', value: '1', disabled: true }],
          parameters: [{ name: 'q', value: '1', disabled: true }],
          body: {
            mimeType: 'multipart/form-data',
            params: [
              { name: 'f', type: 'file', fileName: 'C:\\tmp\\one.txt' },
              { name: 'off', value: 'no', disabled: true },
            ],
          },
        },
      ]) as never,
    ).items[0] as ApiRequestSpec;
    expect(spec.headers[0]?.enabled).toBe(false);
    expect(spec.query[0]?.enabled).toBe(false);
    const fields = spec.body.mode === 'form' ? spec.body.fields : [];
    expect(fields[0]?.value).toBe('one.txt');
    expect(fields[1]?.enabled).toBe(false);
  });

  it('reads a graphql body that is not JSON and one with no variables', () => {
    const graphql = (text: string) =>
      (
        importInsomnia(
          document([
            {
              _type: 'request',
              _id: 'r',
              parentId: 'w',
              name: 'R',
              url: 'https://a.test/',
              body: { mimeType: 'application/graphql', text },
            },
          ]) as never,
        ).items[0] as ApiRequestSpec
      ).graphql;

    expect(graphql('{ a }')).toEqual({ query: '{ a }' });
    expect(graphql('')).toEqual({ query: '' });
    expect(graphql(JSON.stringify({ query: '{ a }', variables: {}, operationName: 'Q' }))).toEqual({
      query: '{ a }',
      operationName: 'Q',
    });
    expect(graphql(JSON.stringify({ query: '{ a }', variables: { id: 1 } }))).toMatchObject({
      variables: '{\n  "id": 1\n}',
    });
  });

  it('reads a folder whose environment holds values that are not strings', () => {
    const imported = importInsomnia(
      document([
        {
          _type: 'request_group',
          _id: 'g',
          parentId: 'w',
          name: 'Folder',
          environment: { text: 'a', number: 2 },
          preRequestScript: 'insomnia.environment.set("a", 1);',
        },
      ]) as never,
    );
    const folder = imported.items[0];
    expect(folder?.type).toBe('folder');
    expect(folder?.type === 'folder' ? folder.vars : []).toEqual([
      { key: 'text', value: 'a' },
      { key: 'number', value: '2' },
    ]);
  });

  it('reads a request that carries only an after-response script', () => {
    const spec = importInsomnia(
      document([
        {
          _type: 'request',
          _id: 'r',
          parentId: 'w',
          name: 'R',
          url: 'https://a.test/',
          afterResponseScript: 'insomnia.test("ok", () => {});',
        },
      ]) as never,
    ).items[0] as ApiRequestSpec;
    expect(spec.scripts?.postResponse).toBeTruthy();
    expect(spec.scripts?.preRequest).toBeUndefined();
  });
});

describe('exportInsomnia writes the fields an auth may leave out', () => {
  const resourcesOf = (input: CollectionInput) =>
    (exportInsomnia(input) as { resources: Record<string, unknown>[] }).resources;

  it('writes each auth with and without its optional fields', () => {
    const auths: RequestAuth[] = [
      {
        type: 'oauth2',
        grantType: 'client_credentials',
        accessTokenUrl: 'https://id.test/t',
        clientId: 'id',
        clientSecret: 'secret',
      },
      { type: 'awsv4', accessKeyId: 'AK', secretAccessKey: 'SK', service: 's3', region: 'r' },
      { type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs', signatureMethod: 'HMAC-SHA1' },
      { type: 'wsse', username: 'u', password: 'p' },
      { type: 'none' },
    ];
    const resources = resourcesOf(
      collection(auths.map((auth, index) => request({ id: `r${index}`, name: `R${index}`, auth }))),
    );
    const found = resources.filter((resource) => resource['_type'] === 'request');
    expect(found.length).toBe(auths.length);
    const oauth2 = found[0]?.['authentication'] as Record<string, unknown>;
    expect(oauth2['scope']).toBe('');
    const aws = found[1]?.['authentication'] as Record<string, unknown>;
    expect(aws['sessionToken']).toBe('');
    const oauth1 = found[2]?.['authentication'] as Record<string, unknown>;
    expect(oauth1['tokenKey']).toBe('');
    expect(oauth1['tokenSecret']).toBe('');
    expect(oauth1['realm']).toBe('');
  });

  it('writes form files and a binary body with no file attached', () => {
    const resources = resourcesOf(
      collection([
        request({
          id: 'form',
          name: 'Form',
          method: 'POST',
          body: {
            mode: 'form',
            fields: [
              { key: 'a', value: 'fallback.txt', type: 'file' },
              {
                key: 'b',
                value: '',
                type: 'file',
                file: { fileName: 'b.bin', contentType: '', data: '' },
              },
            ],
          },
        }),
        request({ id: 'bin', name: 'Bin', method: 'POST', body: { mode: 'binary', file: null } }),
      ]),
    );
    const form = resources.find((resource) => resource['name'] === 'Form');
    const params = (form?.['body'] as { params: Record<string, unknown>[] }).params;
    expect(params[0]?.['fileName']).toBe('fallback.txt');
    expect(params[1]?.['fileName']).toBe('b.bin');
    const binary = resources.find((resource) => resource['name'] === 'Bin');
    expect((binary?.['body'] as Record<string, unknown>)['fileName']).toBe('');
  });

  it('writes a graphql request with no spec, with bad variables and with an operation name', () => {
    const resources = resourcesOf(
      collection([
        { ...request({ id: 'a', name: 'Bare' }), kind: 'graphql' },
        {
          ...request({ id: 'b', name: 'Bad' }),
          kind: 'graphql',
          graphql: { query: '{ a }', variables: 'not json' },
        },
        {
          ...request({ id: 'c', name: 'Named' }),
          kind: 'graphql',
          graphql: { query: '{ a }', variables: '  ', operationName: 'Q' },
        },
      ]),
    );
    const bodyOf = (name: string) =>
      JSON.parse(
        String(
          (resources.find((resource) => resource['name'] === name)?.['body'] as Record<string, unknown>)[
            'text'
          ],
        ),
      ) as Record<string, unknown>;
    expect(bodyOf('Bare')['query']).toBe('');
    expect(bodyOf('Bad')['variables']).toEqual({});
    expect(bodyOf('Named')['operationName']).toBe('Q');
  });

  it('writes the redirect and url-encoding settings only when they are set', () => {
    const resources = resourcesOf(
      collection([
        request({ id: 'on', name: 'On', settings: { followRedirects: true, encodeUrl: true } }),
        request({ id: 'off', name: 'Off', settings: { followRedirects: false } }),
        request({ id: 'none', name: 'None' }),
      ]),
    );
    const settingOf = (name: string, key: string) =>
      resources.find((resource) => resource['name'] === name)?.[key];
    expect(settingOf('On', 'settingFollowRedirects')).toBe('on');
    expect(settingOf('On', 'settingEncodeUrl')).toBe(true);
    expect(settingOf('Off', 'settingFollowRedirects')).toBe('off');
    expect(settingOf('None', 'settingFollowRedirects')).toBeUndefined();
  });
});
